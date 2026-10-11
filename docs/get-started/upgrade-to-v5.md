# Upgrade to v5

v5 is a faithfulness release. Every change below moves a surface that used to answer its own way onto the answer the `git` binary gives — object reads that git streams, ref updates that git verifies and dereferences, reflog expiry that reads git's own configuration keys and clocks, push, fetch, merge, pull and rebase that report and refuse the way git does, alternate object stores that are read, and a memory adapter that resolves symlinks and refuses the way the Node one does. Nothing here was added for its own sake: each item is a place tsgit and git disagreed, and git won.

There are no renamed exports and no removed commands. The breaking part is behaviour — calls that used to throw may now succeed, calls that used to succeed may now refuse, and some return values changed shape (`revParse`, `pull`, `MergeResult`, `FetchUpdate`, `remote.show`). Read the sections that cover the surfaces you use; if you only read and write objects, the first section is enough.

## Object reads

**A loose blob whose stored header lies about its size is now readable.** `readObject`, `readBlob`, `catFile`, `streamBlob` and `checkout` all serve its real inflated bytes instead of refusing, because that is what git's streaming tier does. `verifyHash: true` still refuses it with `OBJECT_HASH_MISMATCH`, and a size-lying commit, tree or tag still refuses `INVALID_OBJECT_HEADER` — git only streams blobs. If you relied on a read throwing for such an object, gate on `verifyHash` instead.

**`catFile` and `catFileBatch` report the stored header's size claim.** The `size` on an entry is now what the loose header says, matching `git cat-file --batch` and `git cat-file -s`. For every honest object that is the content length, so nothing changes; only a corrupt header makes the two differ. `readObjectMetadata` is unchanged and stays content-derived — use it when you want the real byte count.

**`RawObject` no longer carries `bytes`.** The pre-parse product of an object read is now `{ type, content }` — the header-prefixed buffer field is gone, because a read no longer materialises one. A caller that genuinely needs the loose-format bytes builds them: the serialized `<type> <size>\0` header followed by `content`. `content` still may alias the object cache, so treat it as immutable and copy before mutating. The type is now public — re-exported from the primitives barrel rather than internal-only.

**`streamBlob` against a loose non-blob refuses at the `await`, not at the first chunk.** `UNEXPECTED_OBJECT_TYPE` now arrives when you await the call rather than when you start pulling from the returned stream. Callers that wrapped only the iteration in `try`/`catch` need to move the handler up to the call itself.

**Buffered reads consult packs before loose objects.** `readObject`, `readBlob`, `catFile`, and every tree and commit read now answer from a pack hit before the loose store, matching git's own `do_oid_object_info_extended` for info and buffered content. An impostor or corrupt loose copy of a packed object is no longer served, and no longer fatal, on any of these paths — the pack copy wins, the way `cat-file -s`/`-t`/`--batch-check`, `diff`, `grep`, `blame` and `archive` already behave against real git. `streamBlob` is unchanged: it still reads loose first, the way git's `stream_blob_to_fd` does, so a small blob streamed to output can still see a loose impostor's bytes. Two divergences from git remain on this seam — both pre-existing, recorded rather than fixed here: a garbage (non-zlib) loose file with no packed twin refuses `DECOMPRESS_FAILED` where git reports `fatal: Not a valid object name` (exit 128); and `streamBlob`/`openBlobSource` against a corrupt loose copy of a packed object throws `DECOMPRESS_FAILED` where git's streaming reader falls back to the pack instead.

**An unreadable `objects/pack` directory no longer refuses.** Reading it used to be loose-first-insulated for ordinary reads and only reachable through `hasObject`'s `all()`/`lookup()`-style callers, where a `PERMISSION_DENIED` (or any other coded fault) propagated as a refusal. Now that buffered reads touch the pack directory first, the same fault folds into an empty listing plus one `ctx.logger?.warn` per generation instead — the way git prints its `unable to open object pack directory: …` line and keeps going. Loose objects are still served; a packed object behind the unreadable directory now refuses `OBJECT_NOT_FOUND` rather than `PERMISSION_DENIED`.

**A pack entry whose inflated bytes disagree with its own header-declared size is refused.** `readObject`, `readBlob`, `catFile`, `streamBlob`/`openBlobSource`, and pack ingestion during `fetch`/`clone` (`index-pack`) all refuse `INVALID_PACK_ENTRY { offset, reason: 'bad object: inflated size differs from declared size' }` when a base entry's — or a delta's instruction stream's — inflated length differs from its header's own claim, in either direction: git's uniform `unpack_entry_data` check (`stream.total_out != size`), now applied on read as well as on write (`pack has bad object at offset N` / `packed object … is corrupt`). Previously an over-long entry refused `DECOMPRESS_FAILED` (tripping the inflate output cap) and a short one passed silently, serving truncated content as if it were whole.

**A content read that finds an object in no pack and no loose file re-scans the pack directory once before refusing.** `readObject`'s buffered resolver and `streamBlob`/`openBlobSource`'s streamed source both retry a full miss exactly once — git's own `oid_object_info_extended` → `reprepare_packed_git` → retry-once — for an external `git repack`/`gc`, or a lazy fetch outside this session, that changed the store since the registry's last scan. The re-scan is incremental (git's own `reprepare_packed_git` shape): every pack the registry already knows, its parsed `.idx`, its handle and its window-cache entries, and a loaded multi-pack-index all survive; only a vanished or newly-listed pack changes. Concurrent misses in the same session join one re-scan rather than each starting their own.

**`hasObject` gained a second argument, `options?: { mode?: 'quick' | 'recheck' }`.** `'quick'` (the default, and the only behaviour before this release) never re-scans the pack directory on a miss — git's `has_object` default, since a negotiation walk probes routinely-absent haves. `'recheck'` re-scans once on a miss — git's `HAS_OBJECT_RECHECK_PACKED` — and `fetch`'s everything-local check now passes it, as git's `check_exist_and_connected` does, so an object a lazy fetch or an external `git repack` already landed is not wrongly reported absent.

**`hasObject`'s loose arm still answers from a per-session listing of the loose fanout directory, not a filesystem probe per call — but the listing is no longer sticky for the rest of the session.** Each `objects/xx` fanout directory is still `readdir`'d lazily at most once and cached as a membership set, shared with every other loose lookup the session makes. What changed: a buffered or streamed content read's own full-miss re-scan (above) now drops the one fanout prefix it just missed on, so an object another process writes into the loose store becomes visible to a later content read on the same open repository — not only after a new repository handle. `hasObject({ mode: 'quick' })` — the default — still never triggers that re-scan on its own; pass `{ mode: 'recheck' }`, or read the object's content instead, to see a fresh external write mid-session.

## `updateRef` and ref writes

This is the largest group. `updateRef` was a thin compare-and-swap over one ref file; it is now git's ref transaction — it verifies the object it is about to point at, walks symbolic refs, and deletes the way `git update-ref` deletes.

**`updateRef` verifies its target before the compare-and-swap.** A missing object refuses `OBJECT_NOT_FOUND`; bytes that do not hash to the id given refuse `OBJECT_HASH_MISMATCH`; a commit or tag git's own parser rejects refuses `INVALID_COMMIT` or `INVALID_TAG`; and a non-commit written to `HEAD` or `refs/heads/*` refuses `UNEXPECTED_OBJECT_TYPE` with `expected: 'commit'`. The type rule keys off the name you passed, not what a symref resolves to. If you pass a wrong `expected` *and* a bad target, you now get the target refusal rather than `REF_UPDATE_CONFLICT`. Deletes and symbolic writes are not verified. Budget for one extra object read and hash per verified update.

**A symlinked ref whose link text is not a valid `refs/`-prefixed name is read through.** Previously such a `HEAD` refused `INVALID_REF`; now the linked file's own content decides, exactly as git's `read_ref_internal` does — a raw object id reads as a direct ref, a `ref: …` line as a symbolic one. A `commit` through such a `HEAD` then replaces the link with a regular file when it was direct, or advances the named branch when it was symbolic.

**`updateRef(name, <null id>, …)` deletes the ref.** Writing the all-zeroes id used to store a ref holding the null id; it is now the same delete as `delete: true`, matching `git update-ref <ref> 0{40}` — compare-and-swap honoured, the ref's own reflog removed, no target verification. If you were using the null id as a tombstone value, switch to an explicit delete or to a real id.

**`updateRef` dereferences symbolic refs.** Writing or deleting through a symref now changes the ref it points at and leaves the symref in place, as `git update-ref` does. Every symbolic ref walked gets a reflog entry, and so does a `HEAD` that names one; `expected` is compared against the target's value, not the link's; a symref cycle refuses `REF_CYCLE_DETECTED`; there is no depth cap. Pass `noDeref: true` (git's `--no-deref`) to act on the name itself. One detail worth knowing if you read reflogs byte-for-byte: the old id of a `HEAD` entry that came through a symref is the null id on the files backend and the resolved id on reftable, because git's two backends write it differently.

**A read resolves four symbolic hops, not five.** The chain cap now counts the refs one resolve reads, the terminal included, as git's `SYMREF_MAXDEPTH` does. A chain exactly five symbolic hops deep used to resolve and now refuses `REF_CHAIN_TOO_DEEP`. Nothing shallower changes, and `updateRef`'s own write-side walk is uncapped as before — a cycle, not a depth, is what ends it.

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

**Malformed `core.packedGitWindowSize` / `core.packedGitLimit` now refuse every command.** tsgit used to accept any value for these keys silently; they are now validated at the eager config gate, and an unparseable, empty, valueless or out-of-range value refuses `CONFIG_BAD_NUMERIC_VALUE`, matching git's own `git_default_config`. A well-formed value can only **lower** tsgit's pack window cache below its defaults (a 64 KiB window, a 16 MiB registry-wide limit): git's own figures are mmap reservations an eager heap-backed cache cannot honour, so a value above a default is clamped to it rather than growing the cache.

**`gc.reflogExpire`, `gc.reflogExpireUnreachable` and their `gc.<pattern>.*` forms are honoured.** Reflog expiry now reads these keys from the repository-local configuration (no global or system scope, matching how git resolves them here). `refs/stash` never expires unless a pattern or an explicit flag says so. The whole configuration is validated before flags, targets or the repository-settings class are looked at, so a valueless entry anywhere refuses `CONFIG_MISSING_VALUE` and an unparseable date refuses `CONFIG_BAD_DATE_VALUE` — which now carries the offending `key`, `source` file and `line` when it comes from a config entry.

## Adapters

**`NodeFileSystem` takes its injected operations in one options object.** `new NodeFileSystem(root, pathPolicy, fsOps, rootsArePreResolved, removeTreeConcurrency)` is now `new NodeFileSystem(root, { pathPolicy, fsOps, rootsArePreResolved, removeTreeConcurrency })`, every member optional. A bare `new NodeFileSystem(root)` is unchanged.

**The `FileSystem` port gains two optional, non-throwing probes.** `tryLstat` and `tryReadUtf8` resolve `undefined` exactly where their throwing twins (`lstat`, `readUtf8`) refuse `FILE_NOT_FOUND`, and behave identically otherwise. Both are optional — a custom adapter that omits them changes cost, not correctness: callers fall back to the throwing method and an `errorDataCode(err) === 'FILE_NOT_FOUND'` check.

**Under `io: 'sync-fast-path'`, a file above `2**31-1` bytes now refuses the same way `'threadpool'` mode already does, instead of being read short.** The sync arm finishes a read past the 64 KiB gate asynchronously, on the same already-open descriptor; past `2**31-1` bytes — where `fs.read`'s length parameter would wrap — it now reopens through `fsOps.readFile` and inherits its refusal (`UNSUPPORTED_OPERATION { operation: 'filesystem', reason: 'ERR_FS_FILE_TOO_LARGE' }`) rather than silently truncating the read.

**A `.git` gitfile prefixed with a UTF-8 BOM now refuses `GITFILE_INVALID_FORMAT` on both `io` modes.** The gitfile grammar requires the exact `gitdir: ` prefix at byte 0; a leading BOM breaks that match, matching git's own refusal (`git rev-parse --git-dir` exits 128 citing `invalid gitfile format`).

**`MemoryFileSystem` resolves symlinks like POSIX.** Every symlinked path component is followed on reads and writes, and `read`, `readSlice`, `readUtf8`, `stat`, `exists` and `readdir` follow the leaf too, up to 40 hops; relative link text resolves against the link's own directory, where `stat` used to resolve it against the adapter root. In practice: a read through a link returns the target's bytes instead of `FILE_NOT_FOUND`, a write through a symlinked directory lands in the target directory instead of refusing `NOT_A_DIRECTORY`, and `exists` on a dangling link is `false` where it used to be `true` — all three now agreeing with the Node adapter. Write leaves, `lstat`, `readlink`, `rm`, `rename` and `openWithNoFollow` still act on the link itself, and `mkdir` follows its leaf as Node does (a link to a directory is a no-op, a dangling link refuses `FILE_NOT_FOUND`). The browser adapter is unaffected — OPFS has no symlinks.

**`MemoryFileSystem` refuses with the Node adapter's codes.** A symlink loop is `PERMISSION_DENIED` (it was `UNSUPPORTED_OPERATION` out of `stat`, and `exists` now throws it rather than answering); reading a directory is `PERMISSION_DENIED` (was `FILE_NOT_FOUND`); `readdir` of a missing path is `FILE_NOT_FOUND` (was `NOT_A_DIRECTORY`); and any path beneath a regular file is `NOT_A_DIRECTORY` (was `FILE_NOT_FOUND`, and again `exists` now throws). Create-surface codes are unchanged. If you test against the memory adapter and assert error codes, expect to update those assertions — the payoff is that a memory-adapter test now predicts Node behaviour.

**A custom adapter may reject with a plain `{ data: { code: 'OBJECT_NOT_FOUND' } }` object.** Everywhere tsgit classifies "was this object missing?", the check is now on the rejection's shape rather than on it being an instance of `TsgitError`. A duck-typed rejection from your own adapter folds in as a missing object — `catFileBatch` yields a `missing` entry for it, promisor retry fires for it, and so on — instead of escaping as an unrecognised error.

## Commands

**`tag.create` of a lightweight tag verifies its target exists.** A missing object refuses `OBJECT_NOT_FOUND`; any existing object type is accepted. An existing tag name still refuses `TAG_EXISTS`, and it does so before the target is verified — for annotated tags too.

**`clone` refuses an advertisement that points at objects it did not get.** If the remote's HEAD branch or detached `HEAD` names a missing, corrupt or non-commit object, or a tag or remote-tracking ref names a missing or corrupt object, the clone refuses instead of writing a ref that does not resolve.

**`name-rev`'s `refs` and `exclude` patterns use git's `wildmatch` dialect.** Patterns containing `[…]` or `\` are now matched as character classes and escapes rather than as literal text. A pattern that happened to contain a bracket and matched literally before will match differently; escape it with `\` if you meant the character.

**`branch.delete` refuses a branch that is not fully merged.** Without `force`, the branch's tip must be reachable from its merge reference or the delete refuses `BRANCH_NOT_FULLY_MERGED` — git's `branch -d` safety valve, which tsgit did not run before. The reference is the branch's configured upstream when that names a commit, and `HEAD` otherwise; an upstream replaces `HEAD` rather than widening the test. A branch that is itself a symbolic ref is still deleted unchecked. If you were deleting branches programmatically and relying on the old unconditional behaviour, pass `force: true`.

**`branch.create` counts an ambiguous start point even when you pass a full object id.** The start point used to be taken at face value the moment it looked like an object id; it now runs the same ambiguity count as every other spelling. In a repository where both `refs/heads/<40hex>` and `refs/tags/<40hex>` exist, `branch.create({ startPoint: '<40hex>' })` refuses `REVPARSE_AMBIGUOUS` instead of creating the branch — which is what `git branch` does there. Only a repository carrying a ref named after a 40-hex string is affected, and git never creates one on its own. One case still differs: with exactly *one* such ref, git cuts the branch from that ref's value rather than from the object the id names, where tsgit uses the object.

**`branch.rename` over an unreadable destination now succeeds.** A destination branch whose loose ref file holds bytes that are not a ref used to refuse `INVALID_REF` (`reason: '<ref> is broken'`); the rename now replaces it, because git's ref rename deletes its destination rather than locking it. The "already exists" refusal is unchanged for a destination that resolves — still `BRANCH_EXISTS` without `force`. `branch.create` over the same broken ref still refuses, forced or not, matching git's own `cannot lock ref … reference broken`. If you were catching `INVALID_REF` around a rename to detect a clobber, catch `BRANCH_EXISTS` instead.

**Commands write refs through `HEAD` the way git does.** `commit`, `merge`, `reset`, `cherryPick`, `revert` and their aborts now write through `HEAD` rather than to the branch directly, so a racing update refuses `REF_UPDATE_CONFLICT` with `name: 'HEAD'`. `branch.create({ force })`, `tag.create({ force })`, the `notes` verbs and `push`'s tracking update move a symref's target instead of overwriting the symref. `branch.delete`, `tag.delete` and `remote.remove` still delete a symref itself, which is also what git does.

**A dangling symlink now counts as occupying a path.** `checkout`, `reset({ mode: 'hard' })` and `stash.apply` / `stash.pop` probe a target path without following links, so a dangling symlink sitting where a file is about to be written is reported as a dirty or untracked collision instead of being silently replaced — `CHECKOUT_OVERWRITE_DIRTY` and `STASH_APPLY_WOULD_OVERWRITE` respectively. Pass `force: true` (or clean the link up) where the old behaviour was what you wanted.

**`remote.rename` renames packed-only tracking refs.** It used to refuse `UNSUPPORTED_OPERATION`. The new names are written loose and the old lines leave `packed-refs`, exactly as `git remote rename` does.

**`remote.rename` also reproduces two defects in `git remote rename` itself.** Both are transcribed deliberately, because faithfulness here binds to the binary rather than to what the binary ought to do. Verified against git 2.55.0 on both the files and reftable backends.

- *A symbolic `<remote>/HEAD` target is spliced blind.* git rewrites the moved names by overwriting a fixed byte slice — the 13 bytes of `refs/remotes/` followed by the length of the old name — and applies that same splice to a symbolic ref's **target** without checking the target lives under that remote, or under `refs/remotes/` at all. Renaming `origin` to `up2` turns a `refs/remotes/origin/HEAD` pointing at `refs/remotes/other/main` into `refs/remotes/up2main`, a dangling symref; pointing it at `refs/heads/feature-long-name` yields `refs/heads/feup2long-name`. If the target is *shorter* than the slice, the rename refuses outright and moves nothing — and that refusal beats every name-conflict check.
- *The config section is renamed first and never rolled back.* git commits `remote.<old>` → `remote.<new>` before it moves any ref, and rewrites the fetch refspecs and `branch.<x>.remote` only afterwards. A refusal in between leaves `[remote "<new>"]` still carrying values that name `<old>`, with the refs untouched.

If you rename remotes programmatically, point `<remote>/HEAD` inside its own remote first, and re-read the config after a refused rename rather than assuming it rolled back.

## Revision parsing

**`revParse` returns git's ordered revision list instead of one id** (ADR-940). A plain name answers one entry; ranges and parent shorthands answer several, in the order `git rev-parse` prints them, with excluded revisions flagged rather than prefixed. An argument that is not a revision but names an existing path comes back as a `path` entry.

```ts
// before
const head: ObjectId = await repo.revParse('HEAD');
// after
const [head] = await repo.revParse('HEAD');          // { kind: 'object', id, negated: false }
await repo.revParse('main..topic');                   // topic, then main with negated: true
await repo.revParse('topic^@');                       // topic's parents
```

Internal callers that need one object are unaffected. If you want one id, take the first entry and check `kind === 'object'`; a range expression there is no longer a refusal. A refusal raised after git has already printed lines (`A...B` with a non-commit side) carries those entries in its error data.

**`@{upstream}`, `@{u}` and `@{push}` resolve everywhere a revision does.** They were not supported before. Unresolvable marks refuse `BRANCH_MARK_UNRESOLVED`, with git's reason. Reflog selectors go through git's `dwim_log`, and `HEAD` is named through `get_oid`.

**An ambiguous abbreviated id lists every candidate** (ADR-941). `AMBIGUOUS_OID_PREFIX` used to carry at most 16. `candidates` now holds all of them in git's order (tags, commits, trees, blobs), each described as git's hint describes it: a commit or tag with `date` and `subject`, a tree or blob by type, and `bad-object` / `bad-tag` for unreadable ones. A repository crafted to collide on a short prefix can now make that error as large as git's stderr would be.

```ts
// before: error.data.candidates.length <= 16, entries { id, type }
// after:  every candidate; commits and tags also carry { date, subject }
```

**Revision-taking commands type objects the way git's lookups do.** `mergeBase` looks each argument up as a commit (annotated tags peel) and refuses the first that names none with `INVALID_COMMIT_NAME`; a parent that fails to parse refuses `COMMIT_PARSE_FAILED`, as git's walk dies on it. `revList`, `rangeDiff` and `bundle.create` parse both range ends into one object table and refuse a bad end with `INVALID_REVISION_RANGE` or `INVALID_SYMMETRIC_RANGE`; `rangeDiff` also refuses a range whose two ends are one object with `NEED_TWO_COMMIT_RANGES`. A tree entry stored as another type refuses `TREE_ENTRY_TYPE_MISMATCH` or `BAD_TREE_OBJECT` in `revList --objects`. git's `error:` lines go to `ctx.logger.error`. Catch these codes where you caught `OBJECT_NOT_FOUND` or `REVPARSE_UNRESOLVED` for these inputs.

**Tag chains peel to any depth.** The depth cap is gone; only a chain that revisits an object refuses `REF_CHAIN_TOO_DEEP`.

**`walkCommits` gains `order: 'topo-order'`**, git's `--topo-order`: every commit is read before the first is yielded, and a commit comes after all its children. `'breadth-first'` names the former queue order and `'topo'` stays as its alias.

## Push

**A rejected ref no longer throws; `push` reports it per ref** (ADR-942). The call carries on with the other refs, as git does, and resolves with every ref's outcome. `NON_FAST_FORWARD` is no longer thrown by `push` (it remains `merge`/`pull`'s code for `fastForward: 'only'`).

```ts
// before
try { await repo.push({ refspecs: ['main'] }); }
catch (e) { if (e.data.code === 'NON_FAST_FORWARD') handle(e.data.name); }
// after
const { pushedRefs } = await repo.push({ refspecs: ['main'] });
for (const ref of pushedRefs) {
  if (ref.status === 'rejected') handle(ref.name, ref.rejection, ref.reason);
}
```

`rejection` is one of `'non-fast-forward'`, `'needs-force'`, `'fetch-first'`, `'already-exists'`, `'stale-info'` (a `forceWithLease` expectation that no longer holds), `'remote-ref-updated'` (`forceIfIncludes`), `'remote-ref-not-deletable'`, `'atomic-push-failed'`, or `'remote'` (the server's `ng`, text in `reason`). A stale lease is a rejection too, not a `PUSH_REJECTED` throw.

**`atomic` is opt-in.** Push used to request the server's `atomic` capability whenever it was advertised. It now does so only for `push({ atomic: true })`, as `git push --atomic` does, and throws `ATOMIC_PUSH_UNSUPPORTED` when the server does not advertise it. Refs held back by another ref's rejection report `'atomic-push-failed'`.

**Leases follow git's compare-and-swap.** An `'auto'` lease on a tag or an untracked ref expects the remote ref absent and reports `'stale-info'`, instead of refusing `lease-on-non-branch`; a delete is checked against the lease too.

**`report-status-v2` is spoken when advertised.** A ref a `proc-receive` hook rewrote is reported under its rewritten name and ids, with `forcedUpdate` set when the hook says so. Remote-tracking refs follow the rewritten reports.

**More git behaviour on the same call.** `PushOptions.forceIfIncludes` and `push.useForceIfIncludes` are honoured under an automatic lease. A full delete the server did not advertise is sent, and a short delete destination is matched against remote refs (`PUSH_REFSPEC_UNMATCHED` when it matches none or several). A branch with several `branch.<b>.merge` values refuses `PUSH_MULTIPLE_UPSTREAMS` when push needs its upstream. Only the capabilities git's `send-pack` requests are requested.

## Fetch

**`FetchUpdate` is a union with a status and a source** (ADR-944). Every update carries `source` (the remote ref) and `status`; a rejected one keeps its old id.

```ts
// before: { name, oldId, newId }
// after
type FetchUpdate =
  | { name; source; oldId: ObjectId | undefined; newId; status: 'ok' }
  | { name; source; oldId: ObjectId; newId; status: 'rejected'; rejection: 'non-fast-forward' | 'would-clobber-existing-tag' };
```

A ref mapped without `+` is no longer moved when the fetched commit does not descend from it, and an existing tag is never moved without `+`. Both used to be overwritten silently. `fetch` resolves, performing every other update; `pull` refuses `FETCH_REJECTED` before merging.

**`refspecs` are git's command-line refspecs.** They replace `remote.<name>.fetch` (the default is now that config, not a fixed branches refspec), short sources are matched like `find_ref_by_name_abbrev`, and every ref they name is listed for merging in `FETCH_HEAD`. `refmap` (git's `--refmap`) maps them onto tracking refs; without `refspecs` it refuses `INVALID_OPTION`. `FETCH_HEAD` is now written as git writes it, and tags follow the fetched history.

**New refusals.** A refspec writing a branch some worktree holds refuses `FETCH_INTO_CHECKED_OUT_BRANCH`. Two remote refs mapped onto one local ref refuse `FETCH_REFSPEC_CONFLICT`. A configured or exact source the remote does not advertise refuses `REMOTE_REF_NOT_FOUND`. Fetching from an empty remote succeeds with an empty `FETCH_HEAD`. Reflog messages carry git's argv-derived action (`fetch origin main:other: storing head`), and `refs/remotes/<remote>/HEAD` follows `remote.<remote>.followRemoteHEAD`.

## Merge and pull

**`pull` returns a discriminated result.** `PullResult` is `{ fetch, integration: 'merge', merge } | { fetch, integration: 'rebase', rebase }`; branch on `integration` instead of reading `result.merge` unconditionally.

**A divergent pull refuses unless told how to reconcile** (ADR-946). With neither `rebase` nor `pull.rebase`/`pull.ff` choosing, and the fetched head diverged from `HEAD`, `pull` refuses `PULL_DIVERGENT_BRANCHES` after the fetch. Pass `rebase: false` to keep merging.

```ts
await repo.pull({ rebase: false });      // the old implicit merge
await repo.pull({ rebase: true });       // or 'merges'
```

`pull` merges what the fetch marked for merging in `FETCH_HEAD`, not `branch.<b>.merge` read directly; `ref` is now a command-line refspec (`git pull <remote> <ref>`). When nothing is marked it refuses with `PULL_NO_MERGE_CANDIDATES` or `NO_UPSTREAM_CONFIGURED`. A pull into an unborn branch works, and a pull whose fetch moves the checked-out branch fast-forwards the work tree.

**`merge` gains git's options** (ADR-945), also accepted by `pull`: `squash`, `commit: false`, `strategy` (one name or a list tried in turn), `strategyOptions`, `log`, and `autostash`, with `merge.log`, `merge.autostash`, `pull.twohead`, `pull.octopus` and `branch.<b>.mergeoptions` honoured. Unknown names refuse `UNKNOWN_MERGE_STRATEGY`, `UNKNOWN_STRATEGY_OPTION`, `UNKNOWN_OPTION` or `AMBIGUOUS_OPTION`; a squash combined with `fastForward: 'never'` refuses `INCOMPATIBLE_OPTIONS`.

**`MergeResult` has two more variants.** A merge that ends without a commit no longer reports as a merge.

```ts
// squash:   { kind: 'squashed', origHead, conflicts? }   // SQUASH_MSG written, HEAD unmoved
// commit:false: { kind: 'stopped', mergeHead, origHead } // MERGE_HEAD + MERGE_MSG kept
```

An exhaustive `switch (result.kind)` over `MergeResult` needs both arms. Merging several heads is supported (git's `reduce_heads`, octopus strategy), unrelated histories refuse `UNRELATED_HISTORIES` unless `allowUnrelatedHistories`, and a merge into a detached `HEAD` stays detached.

**The merge core detects renames like `ort`** (ADR-947). A file renamed on one side and edited on the other merges into its new path, directory renames apply per `merge.directoryRenames`, and rename/delete, rename/rename and rename/add stop as conflicts. Content merges diff with histogram by default (`diff.algorithm` overrides it), conflict markers refine as git's do, and `merge.conflictStyle` `diff3`/`zdiff3` is honoured. Merges that used to conflict or clobber may now merge cleanly, and the reverse; merge commit ids can differ from earlier tsgit output. A merge that git refuses in the directory-rename split case no longer commits.

**Merge commits match git byte for byte.** The default message follows `fmt_merge_msg`, a signed-tag merge carries git's `mergetag` header and comment block, and the reflog reads `Merge made by the 'ort' strategy.` instead of `'tsgit'`. Merge commits can be signed through `sign`/`signKey` or `commit.gpgSign`. A conflicted merge, cherry-pick, rebase, revert or stash no longer drops cleanly line-merged paths from the index.

**Local changes can be stashed around the operation**, as `--autostash` does, by `merge`, `pull` and `rebase` through `MERGE_AUTOSTASH` / `rebase-merge/autostash`, with git's `Created autostash` / `Applied autostash` messages.

## Rebase

**`upstream` and `onto` accept any revision that peels to a commit**, and `onto` accepts `A...B`. Before, only a ref or object id resolved (`rebase HEAD~3` threw `REF_NOT_FOUND`). A bad revision refuses `REBASE_REVISION_INVALID`.

```ts
// before: await repo.rebase({ upstream: 'abc123…' });
await repo.rebase({ upstream: 'HEAD~3' });
```

**`rebaseMerges` and `autostash` are new options**, and the replay walks git's right-only, merge-free, graph-ordered range. A stop leaves git's marker files (`MERGE_MSG`, `message-fixup`, `amend`, `current-fixups`), and an `edit` stop followed by `skip` keeps the edited commit. `pull --rebase` rebases from git's fork point.

## Other commands

**`rm` refuses a directory without `recursive`.** A literal pathspec that reaches only paths under a directory refuses `RM_RECURSIVE_WITHOUT_R`; pass `recursive: true`.

**`checkout` refuses unresolvable and non-commit switch targets** (`CHECKOUT_NON_COMMIT`, `CHECKOUT_START_POINT_NOT_COMMIT`) and peels tags.

**`name-rev` names a tag, tree or blob only by a ref pointing straight at it,** and returns `undefined` for an argument git cannot read instead of throwing. `nameRev` skips a dangling ref rather than refusing every input.

**`remote.show` reports every merge value.** `trackedBy[].merge` is `ReadonlyArray<string>` (was `string | undefined`), and a branch with no merge value is omitted.

**`branch.create` records tracking** (`track`, `noTrack`, `upstream` in the result), and `branch.delete`/`push` reachability checks refuse `COMMIT_PARSE_FAILED` as the merge-base walk does.

**`maintenance` reports a failed task instead of throwing.** `tasksFailed` lists each `{ task, code, data }` and the remaining tasks still run. A commit-graph write over an unparseable commit refuses `TREE_UNREADABLE`.

**`bundle.create` bundles what git's limited walk picks**, prerequisites included; `BUNDLE_EMPTY` is `reason: 'no-refs'` only, and an empty selection writes an empty pack.

## Alternate object stores

**Alternates are read.** `objects/info/alternates` is honoured for every object read (loose, packed, multi-pack-index, bitmaps and the commit-graph chain), in git's search order, up to git's nesting depth. Before, an alternate's objects were not found.

```ts
const { sources, unusable } = await repo.primitives.objectSources();
```

An alternate that cannot be used is skipped and listed in `unusable` (`unresolvable`, `not-a-directory`, `unreadable-list`, `nesting-too-deep`, `unreachable`), and warned through `ctx.logger`; a read never fails because of it (ADR-914, ADR-916). `fsck` audits every source; `gc` packs the repository's own objects only (git's `repack -l`), `prune` removes only the repository's own loose objects, and a loose copy of an object an alternate already packs is removed; a write that finds the object in any source freshens that copy instead of writing (ADR-922). `GIT_ALTERNATE_OBJECT_DIRECTORIES` is not read (ADR-923). `repo.primitives.abbreviateObjectId` is new and extends an abbreviation past collisions in every source.

**Direct adapter users get alternates too.** `createNodeContext` now reads alternates through the same access `openRepository` uses; containment is unchanged. A caller-supplied `opts.fs` bounds every read, alternates included: it must itself reach an out-of-root alternate, which is otherwise skipped as `unreachable` (ADR-915).

## Command runner and filters

**`CommandRunner` gains `args`, `stderr` and an optional `spawn`** (ADR-938). A request with `args` runs the program directly with no shell; `stderr: 'capture'` returns the child's stderr on `result.stderr`; `spawn` starts a long-running child for `filter.<driver>.process`. A custom `CommandRunner` that lacks `spawn` makes a required process driver refuse, as git refuses a driver it cannot start. Signing and verification now run their programs by argv.

**A required `clean`/`smudge` driver that smudges nothing refuses** `SMUDGE_FILTER_FAILED` (`exitCode` is now optional). `checkout` smudges through `filter.<driver>.process`.

**On Windows, spawned programs resolve through `PATH` only,** never the working tree, and command lines run under `cmd.exe` with `NoDefaultCurrentDirectoryInExePath` set, which the programs they start inherit. A relative `PATH` entry resolves to an absolute one.

## Caches and memory

**The cache family's documented ceiling is about 158 MiB, not 136 MiB.** The parsed-object memo's byte valve is now charged at measured cost rather than an estimate (about 37.7 MiB at SHA-1), and at SHA-256 the flat-tree and memo valves are sized so each still admits its full reference workload. No API changed and no default you set moves — only the number you should budget for.

## What's next

| Want to… | Read |
|---|---|
| Look up an error code's payload | [Errors](../use/errors.md) |
| See the full `updateRef` surface | [`updateRef`](../use/primitives/update-ref.md) |
| See reflog expiry's options and refusals | [`reflog`](../use/commands/reflog.md) |
| See `revParse`'s ordered entries | [`revParse`](../use/commands/rev-parse.md) |
| See push's per-ref rejections | [`push`](../use/commands/push.md) |
| See fetch's per-ref status | [`fetch`](../use/commands/fetch.md) |
| See merge and pull options | [`merge`](../use/commands/merge.md), [`pull`](../use/commands/pull.md) |
| List the object stores a session reads | [`objectSources`](../use/primitives/object-sources.md) |
| Come from `isomorphic-git` instead | [Migration guide](migrate-from-isomorphic-git.md) |
