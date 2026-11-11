# Known divergences

Behaviour where tsgit differs from canonical git, has been proven, and sits **below the
filing bar** of [ADR-1170](adr/1170-a-filing-bar-separates-the-backlog-from-a-divergence-ledger.md).
Each row keeps the proof it was filed with. A row is a fact, not a promise: nothing here is
scheduled.

A row goes back to [the backlog](BACKLOG.md) only when:

- a user reports it, or
- a change already touches its code; it is then folded into that change, not filed.

Ids are the backlog ids the rows carried when they were moved (2026-11-10), so references in
ADRs, design docs and PRs still resolve.

## Corrupt, forged or unreadable input

A damaged object, ref, index or state file, or a file the process cannot read.

- **32.3** Triage Tier 5 — edge (corrupt or forged objects, rare config): stale `SQUASH_MSG` on continue (A3) · rebase `--quit` (A4) · `info/grafts` in rebase linearity (A10) · blame with a missing parent via graph (A25, **verify on main**) · backfill second fetch (B3) · forged unsafe tag name (B9) · v2 option without `ok` (B15) · push/bundle sparse (B20) · forged tag type (C11) · `type bogus` tag (C17) · unparsable header in ambiguity (C18) · malformed commit behind a tag (C20) · malformed commit collision (C21) · huge `^-N` (C-S1) · malformed `core.bigFileThreshold` in archive (C-S2, **verify on main**) · `log ^<blob>` (C-S3) · session graph cache, acceleration only (D1) · ragged OIDL/CDAT (D4) · git `BUG` abort, needs an ADR rather than a copy (D13). Evidence: [faithfulness-triage-2026-10](spike/faithfulness-triage-2026-10.md).

- **32.14** Reftable footer magic is never checked — `readFooter` accepts a footer whose magic git rejects, so a corrupt table is read where git refuses it. Pre-existing; pin by planting a footer with a bad magic and comparing `git for-each-ref` with `refList`.

- **32.34** `revList` refuses a ref that names a size-lying loose blob where git lists it — git 2.55 `rev-list --objects --all` (walk and `--use-bitmap-index`) exits 0 with a ref pointing at a past-window overrun blob; tsgit `revList({ all, objects })` refuses `LOOSE_OBJECT_CORRUPT` on both tiers: `requireReference` → `parseTypedObject` reads the blob body, and `bitmap-binding.ts`'s fill re-reads every peeled want with `readObject`. git's `get_reference` → `parse_object` types a blob header-only (ADR-1032 did this for the closure's wants and `peel`'s hops). Pin both tiers against git, then type the blob from its header. Not folded: out of scope (the brief was gc; pre-existing, the code refused `INVALID_OBJECT_HEADER` before). Refusal-mismatch.

- **32.37** `fsck` labels a loose body that overruns its size claim past the header window `unterminatedHeader` — git reports `error: corrupt loose object '<oid>'` / `unable to unpack contents` / `object corrupt or missing`; tsgit's `looseHeaderFailure` maps the `LOOSE_OBJECT_CORRUPT` read fault to the `unterminatedHeader` msgId, naming a header that is in fact terminated. Exit codes already match (1 unreferenced, 3 referenced). Not folded: out of scope (message-only, listed in the design's out-of-scope). Message-only.

- **32.45** An unreadable submodule or worktree `commondir` gets an error code from which git's `failed to read` line cannot be rebuilt — with an absorbed module whose `.git/modules/sub/commondir` is zero bytes, a directory, or mode 000, git 2.56 `add -- .` exits 128 with `fatal: failed to read sub/../.git/modules/sub/commondir: <No such file or directory | Is a directory | Permission denied>`. tsgit `add` throws `GITFILE_NOT_A_REPOSITORY { path: 'sub/.git' }`, which rebuilds as `gitfile does not point to a valid repository: sub/.git` — git's line for a commondir naming a missing target, a different fault. `openRepository` on a zero-byte commondir throws a third code, `GITFILE_INVALID_FORMAT` (bare-repo-custom-gitdir-interop asserts only `toContain('failed to read')`). The refusal itself agrees (exit 128, index and objects untouched). Fix: one structured code (shape `{ code, path: <gitdir>/commondir, reason }`) raised by both the `add` gitlink probe and discovery; pin both rows to git's literal line rebuilt from the data; the `No such file or directory` git prints for an empty file is a stale errno — decide in the ADR whether `reason` models it. Message-only; needs an ADR (new public error code). _(found during the git 2.56 follow-up review; add-gitlink-interop.test.ts L1170)_
  Not folded: needs its own decision.
  ```
  # git 2.56.0, scrubbed env; module absorbed into .git/modules/sub, then:
  : > .git/modules/sub/commondir; touch untracked; git add -- .
  fatal: failed to read sub/../.git/modules/sub/commondir: No such file or directory   (exit 128)
  mkdir .git/modules/sub/commondir            -> fatal: failed to read sub/../.git/modules/sub/commondir: Is a directory (exit 128)
  printf '.\n' > …/commondir; chmod 000 …     -> fatal: failed to read sub/../.git/modules/sub/commondir: Permission denied (exit 128)
  printf 'nowhere\n' > …/commondir            -> fatal: gitfile does not point to a valid repository: sub/.git (exit 128)
  # tsgit at 64c0bcd6: the "commondir file of zero bytes" row of add-gitlink-interop passes with
  #   git 128 + the literal line above and tsgit { code: 'GITFILE_NOT_A_REPOSITORY', path: 'sub/.git' }
  ```

- **32.47** Spike — `fsck` returns exit 3 (midx-unusable) for a Tier-A midx fault it reaches lazily, where git 2.56 dies 128 depending on which entry is poisoned — ADR-593 (ratified) says a Tier-A midx fault throws as git dies; two cases are instead recorded only as "contained by the child" in docs/design/midx-read-support.md (O12 numPacks understated, O28 LOFF out of range), with no ADR. midx-fsck-interop pins git 128 against tsgit 3 + one `midx-unusable` on HEAD's tree. Moving the LOFF fault to another entry gives: commit (HEAD) git 128, tree git 128, blob git **1** (verify child 128, parent survives); tsgit returns 3 on all three, so even the blob case differs in bit 2. Neither "always throw" nor "always contain" matches git. Question: which midx entries does git 2.56 fsck's parent walk re-read through the midx, by object kind, by reachability (HEAD, reflog-only, unreachable, tag) and by fault (per-entry LOFF vs midx-wide O12 numPacks)? Is that answer deterministic enough to replicate as "throw iff the walk re-reads the poisoned entry", or should an ADR amend ADR-593 to record the containment as a divergence? Refusal-surface (exit code). _(found during the git 2.56 follow-up review; src/application/commands/internal/fsck/pack-health.ts)_
  Not folded: needs its own decision.
  ```
  npx vitest run --project integration test/integration/midx-fsck-interop.test.ts -t "understated|out of range"
  Tests  2 passed | 58 skipped   (git fsck 128, verify 128; tsgit exit 3, one midx-unusable)
  # throwaway variant: craftLoffMidx({ entry: <midx position of id>, row: 5, count: 1 }) on a fresh BASE fixture, 3 runs identical
  HEAD        commit git=128 verify=128 tsgit=3  git stderr: fatal: multi-pack-index large offset out of bounds
  HEAD:<blob> blob   git=1   verify=128 tsgit=3  findings=bad-object,midx-unusable,missing,unreachable,dangling,root
  HEAD^{tree} tree   git=128 verify=128 tsgit=3
  ```

- **32.51** Spike — `readObject` of a loose object under an unreadable fanout directory refuses on the directory, where git names the object — pre-existing, pinned against git 2.56.0: with `.git/objects/96` at mode 000 and HEAD `962da735…`, git `cat-file -t <oid>` exits 128 with `error: unable to open loose object 962da735…: Permission denied` / `fatal: git cat-file: could not get object info`, and `log -1`, `show -s` and `rev-parse --verify HEAD^{commit}` log that error 2–3 times then die `fatal: loose object 962da735… (stored in .git/objects/96/2da735…) is corrupt`; tsgit `readObject(head)` and `revParse('HEAD^{commit}')` throw `PERMISSION_DENIED { path: .git/objects/96 }` with nothing logged (the listing in `listSuffixes`, `loose-oid-cache.ts:72`); `rev-parse HEAD` matches (exit 0). Not folded: out of scope. Question: does git still answer the read when the object also sits in a pack while its fanout dir is unreadable, and which fault (`LOOSE_OBJECT_CORRUPT { id }` plus a logged `unable to open loose object`, or a new code) should the per-prefix listing failure map to at the per-oid read?

- **32.52** `log` and `revList` of a bare tag name whose target id is malformed throw the raw object fault, where git dies `bad object <name>` — pre-existing, pinned against git 2.56.0: tag ref `x` (plus branch `x`) pointing at a tag object naming `zzzz…zzzz`: git `log -1 --format=%H x` and `rev-list x` print the ambiguity warning then `fatal: bad object x` (exit 128; also for a truncated `abc` target); tsgit `log(ctx, { rev: 'x', limit: 1 })` throws `OBJECT_NOT_FOUND { id: <the tag object's own oid> }` and `revList(ctx, { wants: ['x'] })` throws `INVALID_OBJECT_ID { value: 'zzzz…' }`; an absent `aaaa…` target already matches (`OBJECT_NOT_FOUND { id: aaaa… }` vs `bad object aaaa…`). Fix: route the bare-name resolution in `resolve-rev.ts` to `badObject(revision)` as the commit-ish ladder does. Not folded: out of scope.

- **32.1 row D9** — linked-worktree garbage HEAD in fsck/gc (D9). Evidence: [faithfulness-triage-2026-10](spike/faithfulness-triage-2026-10.md).

- **32.1 row D22** — `walkTree` non-strict subtree skip (D22). Evidence: [faithfulness-triage-2026-10](spike/faithfulness-triage-2026-10.md).

- **32.1 row D10 (mistyped-tag half)** — `grep` of a tag whose declared type lies about its target: git dies (`is a commit, not a tree` / `invalid object … given`), tsgit greps the peeled object anyway. Split from row D10 on 2026-11-11; the blob-target half stays in the backlog. Evidence: [faithfulness-triage-2026-10](spike/faithfulness-triage-2026-10.md).

## Message only

Exit codes and data match git; only the wording or the named path differs.

- **32.2** Triage Tier 4 — message only: octopus info lines (A14) · blame warns once (A26) · `src refspec X does not match any` (B11) · `:path` diagnostics (C3) · stdin ambiguity warning (C9, **verify on main**) · `Promise.all` warnings past the first bad arg (C10) · ambiguity line before invalid type (C19, **verify on main**) · GDA2 misfit at parse (D3, **verify on main**) · `mark_tagged` logs (D7) · Bloom chunk warnings on read (D12) · midx error shape (D6). Evidence: [faithfulness-triage-2026-10](spike/faithfulness-triage-2026-10.md).

- **32.46** `branch -d/-D` names a different worktree than git when two worktrees hold the branch — `worktreeBisecting` and `heldBranches` (src/application/commands/internal/checked-out-branches.ts L80–L125) walk `listWorktrees`, which sorts linked worktrees by path on purpose (list-worktrees.ts L205, for a stable `worktree.list`); git's `get_worktrees` walks `.git/worktrees` in readdir order, the bisect check returns the first match and the checkout map keeps the last registration. Two worktrees forced onto `sidecar` (`worktree add --force`), registered `zz` then `aa` (readdir: zz, aa): bisecting in both, git 2.56 `branch -D sidecar` names `…/zz … for bisect` and tsgit names `…/aa` (hold: bisect); with no bisect, git names `…/aa` and tsgit names `…/zz` (hold: checkout). Both tools refuse in every case with the same code and exit; only the `path` field differs, and reaching the state needs `--force`. Fix: give the hold checks an unsorted walk in the adapter's readdir order; `worktree.list` keeps its sort; pin both holds in branch-delete-worktree-interop with the names registered in the reverse of byte order. Data-only (the refusal's `path`). _(found during the git 2.56 follow-up review; checked-out-branches.ts L80)_
  Not folded: needs its own decision.
  ```
  # git 2.56.0, scrubbed env
  git init -q -b main r && cd r && for m in a b c; do git commit -q --allow-empty -m $m; done
  git branch sidecar && git worktree add -q --force ../zz sidecar && git worktree add -q --force ../aa sidecar
  # bisect variant: in ../zz then ../aa: git bisect start; git bisect bad HEAD; git bisect good HEAD~2
  ls -f .git/worktrees   ->  . .. zz aa
  git branch -D sidecar
  bisect: error: cannot delete branch 'sidecar' used by worktree at '<tmp>/i2-bisect/zz' for bisect   (exit 1)
  hold:   error: cannot delete branch 'sidecar' used by worktree at '<tmp>/i2-hold/aa'                (exit 1)
  # tsgit branchDelete({ name: 'sidecar', force: true }) on the same repos, 64c0bcd6
  bisect {"code":"BRANCH_CHECKED_OUT","branch":"refs/heads/sidecar","path":"<tmp>/i2-bisect/aa","hold":"bisect"}
  hold   {"code":"BRANCH_CHECKED_OUT","branch":"refs/heads/sidecar","path":"<tmp>/i2-hold/zz","hold":"checkout"}
  # with --detach worktrees git deletes the branch (exit 0), as tsgit does — no divergence there
  ```

- **32.53** `REF_NOT_FOUND` carries the caller's name raw into its message, where git prints `?` for each control byte — pre-existing, pinned against git 2.56.0: on the name `x<ESC>]0;pwned<BEL>`, git `cherry-pick` prints `fatal: bad revision 'x?]0;pwned?'` and `describe` prints `fatal: Not a valid object name x?]0;pwned?`; tsgit `describe` and `cherryPickRun` throw `REF_NOT_FOUND: ref not found: x\u001b]0;pwned\u0007` with the raw ESC/BEL in both `message` and `data.name`. Fix: `sanitizeForDisplay` in `refNotFound` (`src/domain/refs/error.ts:69`), as `checkoutNonCommit` already does. Not folded: out of scope.

- **32.1 row A22** — `--detach <path>` message (A22). Evidence: [faithfulness-triage-2026-10](spike/faithfulness-triage-2026-10.md).

## Rare configuration and edge input

A well-formed repository, but a configuration, layout or argument shape few callers produce.

- **32.4** `info/grafts` and `refs/replace/*` honoured by history commands — history walks do not apply them (ADR-542 deferred both); the commit-graph writer only refuses to write a graph while they apply, and decorations name replace refs. A subsystem: read grafts and replace refs in the object/commit-read seam, with its own design and ADR. Evidence: [faithfulness-triage-2026-10](spike/faithfulness-triage-2026-10.md).

- **31.9** Bare-repository attribute sources beyond git's default — tsgit reads `info/attributes` and `core.attributesFile` in a bare repository, which is git's default without `attr.tree`. `attr.tree` / `--attr-source` (reading `.gitattributes` from a named tree, e.g. `HEAD`) is not implemented. Also open from the same work:
  - an invalid `core.bigFileThreshold` (and `core.packedGitLimit` / `core.deltaBaseCacheLimit`) is fatal in git but read as absent by tsgit;
  - a loose size claim at or above the 2 GiB inflate ceiling is refused, and that case has not been probed against git. _(surfaced by the diff-core parity hardening review; ADR-907 amendment.)_

- **32.23** A non-fast-forward merge refuses whenever any tracked path lies beyond a symlink — git 2.55 (`merge` exits 128 with `'a/x' is beyond a symbolic link` / `Cannot save the current worktree state`) refuses even when the merge never touches `a/x` (theirs changes only `b`); tsgit refuses only when a CHANGED path lies beyond the link (`findTrackedBeyondSymlink`). The full rule needs a leading-path check per tracked directory on every non-fast-forward merge — measure the cost first. Refusal-mismatch.

- **32.28** Byte-path filesystem port — non-UTF-8 entry names cannot be written, stat'd or unlinked on disk because the `FileSystem` port is string-pathed; tsgit treats them as absent (ADR-973, matching git on macOS), where git on Linux materialises the raw name. Needs a byte-path variant of the port and adapters. Edge (Linux, legacy-encoded names).

- **32.33** Literal `add` under an unreadable directory reports `PERMISSION_DENIED` where git reports the missing pathspec — `add(['missing','p/f'])` with `p` at mode 600: git 2.55 dies "pathspec 'missing' did not match" (exit 128) in both orders; tsgit throws `PERMISSION_DENIED` (pinned before and after the pooled literal stats). Not folded: out of scope (pre-existing refusal order). Refusal-mismatch.

- **32.54** Spike — `rev-parse` of a reflog selector followed by a failing peel (`main@{0}^{blob}`) throws, where git prints the reflog entry's commit — pre-existing, pinned against git 2.56.0: one-commit repo, git `rev-parse 'main@{0}^{blob}'` logs `error: main@{0}^{blob}: expected blob type, but the object dereferences to tree type` then prints commit `dc3d4d86…` (exit 0), and `main@{0}~0^{blob}`, `main@{0}^{nope}` and the ambiguous `x@{0}^{blob}` (branch and tag `x`, both with reflogs) print the same commit; tsgit `revParse` throws `OBJECT_NOT_FOUND` (`^{blob}`) and `REVPARSE_UNRESOLVED` (`^{nope}`); `main@{0}^{tree}` matches. Not folded: out of scope. Question: is git's success its `get_oid_basic` reflog branch reading the whole `}`-terminated string as `@{0}^{blob}` (selector `0}^{blob`, parsed as a date), and which reflog entry does that selector pick when the reflog holds several entries with distinct timestamps?

- **32.1 row A21** — checkout of an unborn non-`heads` HEAD (A21). Evidence: [faithfulness-triage-2026-10](spike/faithfulness-triage-2026-10.md).

- **32.1 row B13** — two srcs one dst refused client-side (B13). Evidence: [faithfulness-triage-2026-10](spike/faithfulness-triage-2026-10.md).

- **32.1 row C22** — tag-of-tree cherry-pick type (C22). Evidence: [faithfulness-triage-2026-10](spike/faithfulness-triage-2026-10.md).

- **32.1 row D15** — `a/../b` pathspecs (D15). Evidence: [faithfulness-triage-2026-10](spike/faithfulness-triage-2026-10.md).

- **32.1 row D19** — valueless `branch.x.merge` (D19, **verify on main**). Evidence: [faithfulness-triage-2026-10](spike/faithfulness-triage-2026-10.md).

- **32.16** (push) — the default `current`/`simple` push does not refuse an ambiguous destination (remote advertising `refs/heads/main` and `refs/heads/refs/heads/main`: git `dst refspec refs/heads/main matches more than one`, exit 1; tsgit pushes). Pinned against git 2.55.

- **32.16** (push) — `:.have` / `main:.have` (git `fatal: invalid refspec`, exit 128; tsgit accepts `main:.have`, rejected as `refs/heads/.have`, and answers `PUSH_REFSPEC_UNMATCHED` for `:.have`). Pinned against git 2.55.

## Performance off the hot path

Measured, on a command that is not on a common caller path.

- **32.15** `:/<regex>` message search without a literal prefilter — measured 6–25 µs per message against 0.1–3 µs for a native RegExp (`quick.*dog` 27–36× slower, `fix.{0,1000}bug` 2.2 s on the measured corpus) when a literal is present. A lazy DFA with a literal prefilter (~1–1.5 kB gz) closes it. **verify on main**: a linear-time automaton for back-reference-free patterns landed in the same PR; re-measure first.

- **32.36** gc stages every pack in memory before installing any — `buildRepack` holds the normal, promisor and cruft `BuildPackResult` bytes together (ADR-1027); peak memory grows from the largest pack to their sum, about one extra full pack on a gc after a history rewrite. `writePackArtifactsViaQuarantine` and `writeCruftPack` write-and-rename in one call, so git's stage-to-disk shape (`.tmp-*-pack` renamed at the end) needs both writers split into stage/install halves plus a cross-build tmp cleanup. The `gc-residency-…-with-…-unexpired-cruft` bench row cannot see pack bytes at its payload size (+6 MB heap is per-object bookkeeping); a large-blob cruft variant would. Not folded: a design of its own. Performance.

- **32.50** Spike — full `fsck` makes about five `lstatIfReachable` and five `openWithNoFollow` calls per loose ref — on a repository with 5031 loose refs, tsgit `fsck` issues 71,059 file-system calls on HEAD and 71,054 on main (`lstatIfReachable` 25163, `openWithNoFollow` 25169, about one each of `exists`, `stat`, `read`, `readUtf8` per ref); wall time 2.40 s including node start and transpile, against 0.31 s for git 2.56 `fsck`. The counts are the same at ref depth 3 and 4, so it is not one call per path component. Locus: `src/application/commands/fsck.ts` and its ref passes through `src/application/primitives/ref-store.ts`. Pre-existing (identical on main 071d8e48). Performance. Question: which fsck passes (ref-content check, root collection, reflog or worktree walks, connectivity) each lstat and open every loose ref, and can they share one lstat and one no-follow read per ref without losing the symlink and unreadable-ref findings? Proven 2026-10-31 at 25492826 and on main 071d8e48, two runs each:
  ```
  # 5031 loose refs, fs proxy counting calls during fsck(ctx)
  HEAD: total 71059 {"lstatIfReachable":25163,"openWithNoFollow":25169,"exists":5557,"stat":5041,"read":5040,"readUtf8":5033, …}
  main: total 71054 {"lstatIfReachable":25163,"openWithNoFollow":25169,"exists":5557,"stat":5041,"read":5040,"readUtf8":5033, …}
  git fsck wall: 0.307s · tsgit fsck wall (incl. node + transpile): 2.403s
  ```
  Not folded: out of scope — a perf pass over fsck's ref passes, outside the broken-ref-chain correctness change.

## Feature gaps

git supports a form that tsgit does not offer, and no caller has asked for it.

- **32.55** Spike — `describe` of a blob never names it as git's `describe_blob` does — pre-existing, pinned against git 2.56.0: one commit with `f` = `x`, annotated tag `v1`: git `describe <blob of f>` prints `v1:f` (exit 0); tsgit `describe(ctx, <blob oid>)` throws `NO_REACHABLE_NAMES { oid: <blob> }` (with a lightweight tag git refuses too: `No annotated tags can describe '<commit>'`). Not folded: adds feature behaviour. Question: which structured result shape carries the blob's describe (the commit's describe fields plus a `path`, no rendered `<tag>:<path>`), and which commit does git's walk pick when the blob appears in several commits or only off HEAD (`--reverse --objects` order, HEAD only or `--all`)?
