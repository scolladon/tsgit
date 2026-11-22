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

- **32.57** `grep` of a commit whose `tree` header names a header-only tag refuses `INVALID_TAG` where git greps — pre-existing, pinned against git 2.56.0. A tag object holding only `object <tree>\n` and a commit whose `tree` line names that tag, both forged with `hash-object --literally`: git `grep NEEDLE <commit>` prints `<commit>:f:NEEDLE` (exit 0); tsgit `grep(ctx, { patterns: [/NEEDLE/], target: { treeish: <commit> } })` throws `INVALID_TAG { reason: 'second line must be type' }`: the peel hop in `peel.ts` parses the whole tag, where git reads only the `object` line. Not folded: out of scope.
  ```
  $ git grep NEEDLE 92928f44e81c11aaa932f64a453a429754e639f5
  92928f44e81c11aaa932f64a453a429754e639f5:f:NEEDLE
  exit=0
  tsgit THROW {"code":"INVALID_TAG","reason":"second line must be type"}
  ```

- **32.58** `grep` of a tag whose target object is missing names the missing id where git names the rev — pre-existing, pinned against git 2.56.0. Tag ref `mt` points at a tag forged with `hash-object --literally` whose `object` line is `2222222222222222222222222222222222222222` (absent): git `grep -F NEEDLE mt` dies `fatal: invalid object 'mt' given.` (exit 128); tsgit `grep(ctx, { patterns: [{ fixed: 'NEEDLE' }], target: { treeish: 'mt' } })` throws `OBJECT_NOT_FOUND { id: '2222…2222' }`. Both refuse; git's line cannot be rebuilt from tsgit's data. Not folded: out of scope.
  ```
  $ git grep -F NEEDLE mt
  fatal: invalid object 'mt' given.
  exit=128
  tsgit THROW {"code":"OBJECT_NOT_FOUND","id":"2222222222222222222222222222222222222222"}
  ```

- **32.66** `openRepository` names `config.worktree`'s parse error before a bad local `core.bare` — pre-existing, pinned against git 2.56.0. `extensions.worktreeConfig = true`, `git config core.bare bogus`, `.git/config.worktree` = `[core`: git dies `fatal: bad boolean config value 'bogus' for 'core.bare'`; tsgit throws `CONFIG_PARSE_ERROR { line: 1, source: …/config.worktree }` because `readRepositoryFormat` scans the scoped file before `resolveBare` (`src/repository/read-repository-format.ts`). Both refuse. Second fault: an unterminated `[core` alone — git names `bad config line 2`, tsgit `line: 1`. Not folded: out of scope (layout-read order).
  ```
  fatal: bad boolean config value 'bogus' for 'core.bare'      git exit=128
  tsgit THROW {"code":"CONFIG_PARSE_ERROR","line":1,"source":"<tmp>/.git/config.worktree"}
  ```

- **32.81** `branch.create` writes a ref over a symlink to an empty directory where git refuses — pre-existing, pinned against git 2.56.0. With `.git/refs/heads/x` a symlink to an empty directory under `.git`, git `branch x` exits 128 (`cannot lock ref 'refs/heads/x': there is a non-empty directory '.git/refs/heads/x' blocking reference 'refs/heads/x'`) and leaves the symlink, with no ref and no reflog. tsgit `branch.create({ name: 'x' })` returns, replaces the symlink with a loose ref file and writes the reflog, with and without `unsafeRawAdapters` (`src/application/primitives/ref-store.ts`). The `.git/logs/refs/heads/x` twin already refuses as git does once the repository wrapper forwards `rmdir`. Not folded: out of scope.
  ```
  # mkdir .git/empty-target; ln -s "$PWD/.git/empty-target" .git/refs/heads/x; core.logAllRefUpdates=true
  git    exit=128  at=symlink  rev-parse refs/heads/x: none
  tsgit  exit=0    at=file     rev-parse refs/heads/x: ok   reflog: branch: Created from main
  ```

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

- **32.73** `rm` of a tracked entry the host cannot stat refuses with a code that hides the name-too-long fault — pinned against git 2.56.0. `S = 's'×300` planted index-only. git `rm -q S` exits 128 (`fatal: git rm: 'S': File name too long`), index unchanged; tsgit `repo.rm([S])` refuses with `CHECKOUT_OVERWRITE_DIRTY` from `removeFile`'s catch-all (`src/application/commands/internal/working-tree.ts`), index unchanged.
  ```
  git rm -q <s300> -> exit 128; ls-files unchanged
  tsgit rm([S])    -> threw {"code":"CHECKOUT_OVERWRITE_DIRTY","localChanges":["<s300>"],"untracked":[]}; ls-files unchanged
  ```

- **32.88** `rm` of a tracked file path where a directory now stands refuses `CHECKOUT_OVERWRITE_DIRTY` where git dies with an I/O error — pinned against git 2.56.0. Both refuse and leave the index untouched; only the code and wording differ. Locus: `src/application/commands/internal/working-tree.ts` (`removeFile`). Not folded: out of scope.
  ```
  # seed: commit base + m; rm m; mkdir m; echo inner>m/inner
  git rm m        -> fatal: git rm: 'm': Operation not permitted ; exit=128 ; index unchanged
  tsgit rm(['m']) -> THROW {"code":"CHECKOUT_OVERWRITE_DIRTY","localChanges":["m"],"untracked":[]} ; index unchanged
  ```

## Rare configuration and edge input

A well-formed repository, but a configuration, layout or argument shape few callers produce.

- **32.4** `info/grafts` and `refs/replace/*` honoured by history commands — history walks do not apply them (ADR-542 deferred both); the commit-graph writer only refuses to write a graph while they apply, and decorations name replace refs. A subsystem: read grafts and replace refs in the object/commit-read seam, with its own design and ADR. Evidence: [faithfulness-triage-2026-10](spike/faithfulness-triage-2026-10.md).

- **31.9** Bare-repository attribute sources beyond git's default — tsgit reads `info/attributes` and `core.attributesFile` in a bare repository, which is git's default without `attr.tree`. `attr.tree` / `--attr-source` (reading `.gitattributes` from a named tree, e.g. `HEAD`) is not implemented. Also open from the same work:
  - an invalid `core.bigFileThreshold` (and `core.packedGitLimit` / `core.deltaBaseCacheLimit`) is fatal in git but read as absent by tsgit;
  - a loose size claim at or above the 2 GiB inflate ceiling is refused, and that case has not been probed against git. _(surfaced by the diff-core parity hardening review; ADR-907 amendment.)_

- **32.56** (grep) — an empty `[diff "<name>"]` section is treated as a configured driver. Pinned against git 2.56.0: `g diff=emp`, a `[diff "emp"]` header with no keys and `diff.default.binary=true` ⇒ `git grep` prints `Binary file HEAD:g matches`; tsgit treats `emp` as a configured driver with `binary` unset and greps `g` as text. Edge: needs both an empty section and `diff.default.binary`.

- **32.59** (diff) — `diff.default.binary` is ignored for a path with no `diff` attribute or with `diff=<name>` naming no configured or builtin driver. Pinned against git 2.56.0: with `diff.default.binary=true`, no `.gitattributes`, and `f1` changed `a\nb\nc\n` → `x\n` between `HEAD~1` and `HEAD`, git prints `-	-	f1` for `diff --numstat` and `Binary files a/f1 and b/f1 differ` for the patch (same for `f1 diff=nosuch`); tsgit `diff(ctx, { from: 'HEAD~1', to: 'HEAD', withStat: true })` returns `added: 1, deleted: 3, binary: false`. A named driver's `diff.<name>.binary`, builtin names included, already matches. `resolveDriverBinary` (`src/application/primitives/internal/resolve-similarity-content-kind.ts`) reads only `diff.<name>.binary` and never falls back to the `default` driver; its callers (numstat and patch in `materialise-patch-files.ts`, the staged binary override, similarity scoring) share the gap. Fix sketch: route them through `userdiffBinaryOverride` (`src/domain/diff/userdiff-binary.ts`). Edge: needs a non-default `diff.default.binary`.

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

- **32.61** `sparseCheckout.set` refuses during a merge where git runs it — pre-existing, pinned against git 2.56.0. With a conflicted merge in progress (`c` at stages 1–3), git `sparse-checkout set dir` exits 0, warns `The following paths are unmerged and were left despite sparse patterns: c`, and writes `extensions.worktreeConfig = true`, `.git/config.worktree` and `.git/info/sparse-checkout`; tsgit `sparseCheckout.set({ patterns: ['dir'] })` throws `OPERATION_IN_PROGRESS { operation: 'merge' }` (`assertNoPendingOperation` in `assertSparseReady`, `src/application/commands/sparse-checkout.ts`) and writes nothing. Not folded: needs a probe of which pending operations git tolerates per verb.
  ```
  git merge side                 # exit 1 (conflict on c)
  git sparse-checkout set dir    # exit 0, warning above; config + pattern file written
  tsgit THROW {"code":"OPERATION_IN_PROGRESS","operation":"merge"}; nothing written
  ```

- **32.62** `readConfig` ignores every key in `config.worktree` but the sparse, `core.fileMode`, `core.trustctime` and `core.checkstat` ones — pre-existing, pinned against git 2.56.0. With `extensions.worktreeConfig = true`, git reads `config.worktree` for every key; tsgit reads it for the sparse keys, `core.fileMode`, `core.trustctime` and `core.checkstat` only, `readConfig` stays local-only (`src/application/primitives/config-read.ts`). A bad `core.fileMode`, `core.trustctime` or `core.checkstat` in `config.worktree` is refused, as git does. Every other key in `config.worktree` is still ignored. Corrupt case: `core.ignorecase = bogus` in `config.worktree` — git `fatal: bad boolean config value 'bogus' for 'core.ignorecase'`, tsgit `status()` succeeds. Not folded: out of scope (every reader's config layer, outside the sparse keys).
  ```
  git config extensions.worktreeConfig true; git config --worktree core.ignorecase bogus
  git status: fatal: bad boolean config value 'bogus' for 'core.ignorecase'     tsgit status() succeeds
  ```

- **32.65** Checkout clears a skip-worktree bit git keeps once sparse is off — pre-existing, pinned against git 2.56.0. Local cone sparse on `b`, `read-tree -mu HEAD`, then `core.sparseCheckout = false` (no `sparse-checkout disable`), then checkout `other` (changes `a/f`): git writes `a/f` and keeps its bit (`S a/f S a/g H b/f H top`); tsgit gives `H a/f S a/g H b/f H top` (`src/application/commands/checkout.ts`). The disk matches; only the index bit differs. Not folded: out of scope.
  ```
  ls-files -t  git:   S a/f S a/g H b/f H top    disk: ./a/f ./b/f ./top
  ls-files -t  tsgit: H a/f S a/g H b/f H top    disk: ./a/f ./b/f ./top
  ```

- **32.68** `status` and `add .` throw on a directory beyond the host PATH_MAX where git warns and walks on — pinned against git 2.56.0 (macOS); at the filing bar but over the net-zero cap (ADR-1170) of the long-pathspec-refusals run. Tracked `D/x` with `D = <a200>/<b200>/<c200>/<d200>`, plus an untracked `D/<e200>/<f200>/<g200>/x` (absolute path 1486 bytes). git `status --porcelain` and `add .` exit 0 and warn `could not open directory 'D/<e200>/…': File name too long`; tsgit `repo.status()` and `repo.add(['.'])` throw from the working-tree walk (`src/application/primitives/walk-working-tree.ts`).
  ```
  git status --porcelain -> exit 0, warning: could not open directory '<a200>/<b200>/…': File name too long
  git add .              -> exit 0, same warning
  tsgit status() / add(['.']) -> threw {"code":"PATH_TOO_LONG","path":"<tmp>/<a200>/<b200>/<c200>/<d200>/<e200>"}
  ```

- **32.69** `add .` throws on a tracked entry the host cannot stat, where git reports it and stages the rest — pinned against git 2.56.0. `S = 's'×300` planted index-only with `update-index --add --cacheinfo`, `base` modified. git `add .` exits 0, prints `S: File name too long` and stages `base`; tsgit `repo.add(['.'])` throws and stages nothing (`src/application/commands/add.ts`).
  ```
  git add .        -> exit 0; ls-files -s base -> 5ea2ed41… (new content)
  tsgit add(['.']) -> threw {"code":"PATH_TOO_LONG","path":"<tmp>/<s300>"}; ls-files -s base -> 61780798… (old)
  ```

- **32.70** `checkout -- .` stops at the first file it cannot create, where git reports it and restores the others — pinned against git 2.56.0. Same setup as 32.69. git exits 255 with `error: unable to create file S…` and restores `base`; tsgit `repo.checkout({ paths: ['.'] })` throws and leaves `base` modified (`src/application/commands/checkout.ts`).
  ```
  git checkout -- .              -> exit 255; diff --name-only -> (empty)
  tsgit checkout({paths:['.']})  -> threw {"code":"PATH_TOO_LONG","path":"<tmp>/<s300>"}; diff --name-only -> base
  ```

- **32.71** `grep` of the index throws from the attributes lookup of a path beyond PATH_MAX, where git warns and reports the hit — pinned against git 2.56.0 (macOS). `P = '<q50>/'×98 + 'x'` (4999 bytes) planted index-only. git `grep --cached -c idx` exits 0, prints `P:1` and warns `unable to access '…/.gitattributes'`; tsgit `repo.grep({ patterns: [/idx/], target: 'index' })` throws (`src/application/commands/grep.ts`).
  ```
  git grep --cached -c idx -> exit 0, <q50>/…/x:1, warning: unable to access '<q50>/…/.gitattributes'
  tsgit grep               -> threw {"code":"PATH_TOO_LONG","path":"<tmp>/<q50>/…/.gitattributes"}
  ```

- **32.76** Under `core.ignoreCase`, a non-forced switch refuses a staged file that differs only in case from a directory the target adds, where git switches — pinned against git 2.56.0 (macOS APFS), unborn HEAD. Staged `DIR`, target `dir/x`. git exits 0 and leaves `AD DIR`, so the staged file's working copy is lost. tsgit refuses `CHECKOUT_OVERWRITE_DIRTY { untracked: ['dir'] }`, because the two-way carry compares file and directory collisions case-exactly (`src/application/primitives/materialize-tree.ts`). With `core.ignoreCase=false` both refuse. Not folded: adds feature behaviour.
  ```
  ic=true  git checkout side -> exit 0; ls-files: DIR, dir/x; status: AD DIR; disk: dir/
  ic=true  tsgit checkout({rev:'side'}) -> {"code":"CHECKOUT_OVERWRITE_DIRTY","localChanges":[],"untracked":["dir"]}; disk: DIR
  ic=false both refuse (git: untracked working tree files would be overwritten: dir)
  ```

- **32.78** `checkout` `createBranch` does not expand `@{-N}` — pinned against git 2.56.0. git expands `@{-1}` in a new branch name: `checkout -b '@{-1}'` recreates a deleted previous branch, and `-B '@{-1}'` resets it. tsgit passes the name to `newBranchRef` unexpanded (`src/application/commands/checkout.ts`, `assertBranchCreatable`) and refuses `INVALID_REF`. Not folded: out of scope.
  ```
  # previous branch feat, then deleted; on main
  git checkout -b '@{-1}'   -> exit 0; HEAD=refs/heads/feat
  tsgit checkout({ createBranch: { name: '@{-1}' } }) -> {"code":"INVALID_REF","reason":"ref name must not contain @{"}; no ref created
  # previous branch -x still present: git checkout -B '@{-1}' -> exit 0, -x reset to HEAD; tsgit: same INVALID_REF
  ```

- **32.79** Under sparse checkout, a switch refuses a symlinked leading directory that git replaces — pinned against git 2.56.0, both `core.ignorecase` values. Unborn HEAD, non-cone patterns `/g /l`, staged `l/dir`, `l` a symlink to an outside directory, target `l/dir/x`. git exits 0 (index `g`, `l/dir/x`; the outside directory is untouched). tsgit refuses `CHECKOUT_OVERWRITE_DIRTY { untracked: ['l'] }` (`src/application/primitives/apply-changeset.ts`). Not folded: needs its own decision.
  ```
  git checkout side -> warning: ...already present and thus not updated despite sparse patterns: l; exit 0
                       idx H g, H l/dir/x; disk ./l/dir/x; the outside directory unchanged
  tsgit checkout({rev:'side'}) -> {"code":"CHECKOUT_OVERWRITE_DIRTY","localChanges":[],"untracked":["l"]}
  ```

- **32.80** Under sparse checkout, git overwrites an untracked file in the way of an in-pattern directory; tsgit refuses — pinned against git 2.56.0, both `core.ignorecase` values. Unborn HEAD, non-cone patterns `/g /dir`, an untracked file `dir` not in the index, target `dir/x`. git exits 0 and the untracked `dir` is lost, despite its "not updated" warning. tsgit refuses `CHECKOUT_OVERWRITE_DIRTY { untracked: ['dir'] }` and keeps the file (`src/application/primitives/materialize-tree.ts`). Without sparse both refuse. Not folded: needs its own decision.
  ```
  sparse    git: exit 0; idx H dir/x H g; disk ./dir/x ./g (untracked dir gone)
  sparse    tsgit: {"code":"CHECKOUT_OVERWRITE_DIRTY","localChanges":[],"untracked":["dir"]}; disk ./dir : untracked
  no sparse git: exit 1 (would be overwritten: dir) | tsgit: same refusal
  ```

- **32.83** An octopus content conflict labels its markers `HEAD` / `<branch>` where git writes random `.merge_file_XXXXXX` temp names — pinned against git 2.56.0. `main` edits `f`, `last` edits `f`, `first` edits `top`; `git merge --no-edit first last` vs `repo.merge.run({ rev: ['first', 'last'] })` (`src/application/commands/merge.ts`). Both stop on the conflict with the same marker body; only the label lines differ, and git's labels are random per run (octopus merges through temp files), so byte parity is impossible. Not folded: out of scope.

- **32.85** Spike — `stash apply --index` of a stash holding a staged change to an excluded path leaves git's entry `H` with the file absent; tsgit leaves it `S` — pinned against git 2.56.0. Cone sparse on `b`, `a/f` staged `f2` through `update-index --no-skip-worktree` with work file `f1`, `git stash`, then `git stash apply --index` vs `repo.stash.apply({ restoreIndex: true })` (`src/application/commands/stash.ts`): both stage blob `9de77c1` and leave `a/` absent; git's `status` reports `MD a/f`, tsgit's `M  a/f`. Question: which step of git's `do_apply_stash` index restore clears the bit without writing the file, and does every `--index` restore of a skip-worktree path do it? Not folded: needs a probe.

- **32.86** A forced `mv` onto an existing file through an untracked symbolic link to a directory outside the work tree refuses `PERMISSION_DENIED` where git writes outside — pinned against git 2.56.0. Tracked `file`, an outside directory holding `full/o`, and an untracked link `link -> ../out/full`: git `mv -f file link/o` exits 0, overwrites the outside `o` and stages `link/o`; tsgit `mv(['file'], 'link/o', { force: true })` throws `PERMISSION_DENIED { path: 'link/o' }` from the working-tree rename (`src/application/commands/internal/working-tree.ts`), index and work tree unchanged. The refusal is ADR-625's write-side leading-path containment, kept on purpose; the in-tree case (ADR-1227) renames through the link as git does. Lifting the guard would need an ADR and a security review. Not folded: needs its own decision.

- **32.89** Spike — a true merge refuses `WORKING_TREE_DIRTY` on an assume-unchanged file edited to the same size within the index's second, where git's merge-ort merges — pre-existing, pinned against git 2.56.0. Both lose the local edit (git writes theirs, tsgit leaves the index blob). Locus: `src/application/primitives/apply-changeset.ts`. Question: does git's pre-merge index refresh move the index mtime past the entry so the whole-second stat match passes, and is that 32.87's mechanism? Not folded: needs a probe.
  ```
  # base f=v1; other: f=theirs; main: keep=k2; update-index --assume-unchanged f; printf 'v2\n' > f
  git merge --no-edit other    -> Merge branch 'other' ; f=[theirs]
  tsgit merge.run({rev:'other'}) -> WORKING_TREE_DIRTY {"localChanges":["f"],"untracked":[]} ; f=[v1]
  ```

- **32.90** `core.checkStat=minimal` is ignored by the plain stat-clean check: `status` reports modified where git trusts the stat — pinned against git 2.56.0. `readStatCheck` feeds only the assume-unchanged drift check; `matchesContentStat` (`src/application/primitives/internal/is-entry-stat-clean.ts`) still compares ctime, uid, gid and inode. Resolved by 32.87. Not folded: out of scope.
  ```
  # echo aaaa>f; touch -t 202001010000 f; add; commit; [config]; echo bbbb>g; touch -r f g; mv g f
  default:                git " M f" | tsgit unstaged:"modified"
  core.checkstat=minimal: git ""     | tsgit unstaged:"modified"
  ```

- **(status)** Under `core.ignorecase = true`, `status` lists an untracked file that is the case variant of a tracked one, where git folds it onto the tracked entry — pinned against git 2.56.0 on a case-insensitive file system (macOS), no sparse checkout needed. Tracked `a/f`, the directory `a` replaced on disk by `A` holding `A/f`: git `status --porcelain` prints ` M a/f` only; tsgit reports `a/f` modified and `A/f` untracked, because the working-tree walk does not fold case against the index (`src/application/primitives/walk-working-tree.ts`). Same row under sparse checkout with the entry skip-worktree: git ` M a/f`, tsgit ` M a/f` plus `?? A/f`. Pinned in `test/integration/skip-worktree-present-files-status-interop.test.ts` (`TSGIT_CASE_VARIANT`). Not folded: out of scope (untracked walk, not the skip-worktree clear).
  ```
  core.ignorecase=true; tracked a/f; rm -r a; mkdir A; echo hi > A/f
  git status --porcelain -> " M a/f"
  tsgit status()         -> changes [a/f modified], untracked ["A/f"]
  ```

- **(status)** `status` throws `PERMISSION_DENIED` on a directory the process cannot read, where git warns and exits 0 — pinned against git 2.56.0 (POSIX, not root). Tracked skip-worktree `a/f` under `a` at mode 000: git `status --porcelain -uall` exits 0 with `warning: could not open directory 'a/': Permission denied`; tsgit's working-tree walk throws `{"code":"PERMISSION_DENIED","path":"<repo>/a"}`. Pinned in `test/integration/posix-only/skip-worktree-present-files-interop.test.ts`. Not folded: out of scope (the walk's refusal on an unreadable directory, shared with `add`; see 32.68 for the same warn-and-walk-on shape).
  ```
  chmod 000 a
  git status --porcelain -uall -> exit 0, warning: could not open directory 'a/': Permission denied
  tsgit status()               -> threw {"code":"PERMISSION_DENIED","path":"<repo>/a"}
  ```

- **(rebase)** A `rebase` that stops on a conflict marks a present gitlink skip-worktree and removes its directory where git leaves it in the pattern — pre-existing, pinned against git 2.56.0. `main` and `other` both change `lib/f`, `other` also `top`; patterns `*\n!sub/` with an empty directory `sub`, applied after `*` or `/lib/`; `git rebase other` vs `rebaseRun({ upstream: 'other' })` (`src/application/commands/rebase.ts`). `cherry-pick` and `merge` of the same history agree with git, so the difference is in the rebase stop. The rows fail on main ac037122. Pinned in `test/integration/sparse-gitlink-writers-interop.test.ts` (`GAPS`). Not folded: out of scope.
  ```
  git   rebase other -> idx M lib/f x3, H sub, H top; disk lib lib/f sub top
  tsgit rebaseRun    -> idx M lib/f x3, S sub, H top; disk lib lib/f top
  ```

- **(cherry-pick)** A `cherry-pick` that stops on a conflict leaves an absent, re-included gitlink skip-worktree where git re-includes it and creates its directory — pre-existing, pinned against git 2.56.0. Same history as (rebase); `/lib/` applied (`sub` is `S`, no directory), patterns `*\n!sub/`; `git cherry-pick other` vs `cherryPickRun({ commits: ['other'] })` (`src/application/commands/cherry-pick.ts`). The row fails on main ac037122. Pinned in `test/integration/sparse-gitlink-writers-interop.test.ts` (`GAPS`). Not folded: out of scope.
  ```
  git   cherry-pick other -> idx M lib/f x3, H sub, H top; disk lib lib/f sub top
  tsgit cherryPickRun     -> idx M lib/f x3, S sub, H top; disk lib lib/f top
  ```

- **(merge)** A `merge` that stops on a conflict does not create the directory of a gitlink it re-includes — pre-existing, pinned against git 2.56.0. Same history as (rebase); `/lib/` applied (`sub` is `S`, no directory), patterns `sub/\n/lib/`; `git merge other` vs `mergeRun({ rev: 'other' })` (`src/application/commands/merge.ts`). The index agrees (`H sub`); only the disk differs. The row fails on main ac037122. Pinned in `test/integration/sparse-gitlink-writers-interop.test.ts` (`GAPS`). Not folded: out of scope.
  ```
  git   merge other -> idx M lib/f x3, H sub, S top; disk lib lib/f sub
  tsgit mergeRun    -> idx M lib/f x3, H sub, S top; disk lib lib/f
  ```

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

- **32.63** `worktree.add` copies neither the main `config.worktree` nor `info/sparse-checkout` — pre-existing, a documented non-goal (ADR-297), pinned against git 2.56.0. After `git sparse-checkout set --cone b`, git `worktree add <path> other` writes both into `.git/worktrees/<id>/`, so the new worktree is sparse (`S a/f S a/g H b/f H top`); tsgit `worktree.add({ path, commitish: 'other' })` writes neither (`src/application/commands/worktree.ts`), its index is all `H` and every file is written. Not folded: out of scope (git's own key filter on `worktree add`).
  ```
  git   .git/worktrees/wg/: … config.worktree … info/sparse-checkout
  tsgit .git/worktrees/wt/: commondir gitdir HEAD index logs ORIG_HEAD
  ```

- **32.75** No `reference-transaction` hook — pinned against git 2.56.0. git calls `.git/hooks/reference-transaction` with `preparing`, `prepared` and `committed` around every ref update. tsgit's `HookName` union (`src/domain/hooks/hook-name.ts`) has no such member, so `branchCreate` and every other ref writer update refs without calling it. The resulting ref matches git's. Not folded: out of scope.
  ```
  # .git/hooks/reference-transaction: echo "$1" >> log
  git branch x                         -> log: preparing prepared committed
  tsgit branchCreate({ name: 'x' })    -> ref written; log: (empty)
  grep -rn reference-transaction src   -> src/application/primitives/reftable-transaction.ts:4 (doc comment only)
  ```
