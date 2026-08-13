# Design — git-parity containment

> Brief: relax the Node adapter's realpath-per-access path containment to canonical git's model —
> validate entry names once at construction, defend symlink escapes on the write path only, exempt the
> object store — and recover the containment tax behind the four losing benchmark scenarios against
> isomorphic-git (`status:clean`, `readBlob:cold` small-pack, `readBlob:cold` fresh-repo,
> `delta-chain:cold`).
> Status: draft → self-reviewed ×3 → **revised against ADRs 625–634** → self-reviewed ×3

## Revision note — ADRs 625–634

All thirteen decision candidates went to the ADR conversation and all thirteen are settled;
nothing below is open. **Eleven were adopted as recommended** — ADR-625 carries DC-1, DC-2,
DC-3 and DC-13; 626 = DC-4, 627 = DC-5, 628 = DC-6, 629 = DC-7, 630 = DC-8, 631 = DC-9,
633 = DC-11 — and their sections are unchanged apart from being restated as decided. **Two
deviate from the recommendation, and those two are the substance of this revision.**

**[ADR-632](../adr/632-symlink-targets-written-verbatim.md) deviates from DC-10.** The design
recommended *keeping* ADR-051's refusal to create a symlink whose absolute target resolves
outside the roots. The user ratified **relaxing it to git parity**: a symlink's target —
absolute or relative — is opaque bytes, written verbatim, never validated against the root
set (§1.2 pin M). ADR-051 is superseded, not refined. The ripple: §4.2's `symlink` target row,
§6's write-escape carve-out, §7.1's defence list (item (e) is gone), §7.3's two planted-link
rows, §11's ADR-051 disposition, R2's exception and R13, the write-side test bucket, and a new
interop scenario 8. **R5 is no longer one mitigation among several — it is the whole line**,
and every sentence about it in this revision says so.

**[ADR-634](../adr/634-status-shared-stat-map.md) deviates from DC-12.** The design
recommended deferring `status`'s shared stat map to its own design and deliberately did not
design it. The user ratified it **in scope**. §10a is new and specifies it; P10 moves from the
surveyed-and-not-proposed table into the in-scope one (P9 moves with it, since ADR-633 ratified
DC-11 into scope as well), R12 is new, R7's blast radius gains its application-layer clause, and
Gates widens — mutation scope to the application-layer files the two slices touch, plus the
`reports/api.json` regeneration those slices' public surfaces now require.

## Context

### The two containment layers today

Every path reaching the filesystem crosses two independent gates.

| Layer | File | Mechanism | Error | Cost |
|---|---|---|---|---|
| Facade validator | `src/repository/wrap-fs-validator.ts` — `wrapFsValidator`, `isContainedIn` | Purely **lexical**: reject any `..` segment (Win32-canonicalising `'.. '`/`'...'`), then a `startsWith(root + '/')` prefix test per root, plus an allowlist for `homedir`/`xdgConfigHome`/`systemConfigPath` | `PATHSPEC_OUTSIDE_REPO` | string ops only; bypassed by `unsafeRawAdapters: true` |
| Node adapter | `src/adapters/node/node-file-system.ts` — `NodeFileSystem.checkContainment` (L989) | **realpath-based**, three modes | `PERMISSION_DENIED` | 1 `realpath` (read/creation) or 1 cached parent `realpath` (lstat) + per-access string work |

`checkContainment(path, mode)` resolves, consults the root set, then dispatches on mode
(`resolveForMode`, L906):

| Mode | Mechanism | Port methods (verified line-by-line) |
|---|---|---|
| `read` | lexical pre-check → `realpath(resolved)` → per-entry post-check | `read` L548, `readSlice` L554, `readUtf8` L574, `stat` L649, `readdir` L659, **`chmod` L733**, `rename` **src** L690 |
| `lstat` | lexical pre-check (with `isExactRoot`) → `cachedParentRealpath(dirname)` → `join(realParent, basename)` → trust the cached per-parent verdict (except the exact-root leaf) | `lstat` L654, `rm` L681, `readlink` L700, `rmRecursive` L740, `openWithNoFollow` L756 |
| `creation` | `realpathForCreation` (cached parent realpath, else `realpathNearestExisting` walk-up) → leaf `lstat` → refuse a symlink leaf (`interpretCreationLstat`) → per-entry post-check | `write` L579, `writeStream` L587, `writeExclusive` L595, `writeUtf8` L603, `appendUtf8` L611, `mkdir` L672, `rename` **dst** L691, `symlink` **linkPath** L725 |

`exists` (L618) does **not** call `checkContainment`: it inlines resolve → `realpath` → canonical-root
check, with an ENOENT arm that re-checks the raw set. `symlink` additionally gates an **absolute**
target through `realpathNearestExisting` + the root set (ADR-051); relative targets are exempt.
That target gate is **removed** by ADR-632 (§4.2) — the link *path*'s own guard stays.

The root set is canonicalised **once per adapter lifetime** (`resolveRootSet` L538 → `loadRootSet`
L510 → `canonicalizeRoots` L475), producing a `RootSet { canonical, all }` of precomputed
`RootPrefix { normalized, withSep }` values. `parentRealpathCache` is a 512-entry / 128 KiB LRU of
`{ realParent, contained }`, cleared by `rename` and `rmRecursive`, not by `rm`.

Prior decisions that constrain this design:
[ADR-042](../adr/042-canonical-root-lazy-realpath.md) (lazy canonical-root realpath),
[ADR-051](../adr/051-symlink-target-containment.md) (symlink target containment — **superseded by
[ADR-632](../adr/632-symlink-targets-written-verbatim.md)**, §11),
[ADR-046](../adr/046-path-policy-abstraction.md) (`PathPolicy`),
[ADR-047](../adr/047-fs-operations-dependency-injection.md) (`FsOperations` DI),
[ADR-485](../adr/485-status-clean-containment-tax-amortisation.md) (the containment tax is the `status:clean` loss; amortise it, verdict
unchanged), [ADR-509](../adr/509-loose-first-precedence-with-loose-oid-cache.md) (loose-before-pack precedence kept; readdir fanout membership
set), [ADR-541](../adr/541-raw-node-adapter-layout-root-set.md) (adapter confined to the layout root set, not their common ancestor),
[ADR-340](../adr/340-consolidate-mode-aware-working-tree-writers.md) / [ADR-341](../adr/341-always-unlink-before-regular-working-tree-write.md) (one shared working-tree writer that always
`rmIfExists` before a regular write), [ADR-226](../adr/226-git-faithfulness-prime-directive.md) (git-faithfulness prime directive),
[ADR-510](../adr/510-persistent-per-pack-file-handles.md) (persistent per-pack file handles).

### Why it must change — the committed evidence

`docs/perf/baseline.md`'s `status` digest, **after** ADR-485's amortisation landed:

```
containmentVerdict 0.17 · lstat 0.10 · compareWorkingTreeDelta 0.09 · isContainedInEitherRoot 0.09
loadCappedUtf8 0.06 · dirname 0.06 · checkContainment 0.05 · guard 0.04 · basename 0.04
… cachedParentRealpath 0.02 · resolveForMode 0.02 · resolveCanonicalRoot 0.01
```

Containment-attributable self-share on `status` = **0.46**, against `lstat 0.10` (the syscall the
check wraps) and `compareWorkingTreeDelta 0.09` (the actual work). The same frames dominate elsewhere:
`isContainedInEitherRoot` 0.24 (diff) / 0.19 (merge) / 0.14 (blame); `checkContainment` 0.13–0.14
(diff/blame); `exists` 0.27 (name-rev) / 0.23 (describe) / 0.16 (log). On POSIX
`normalizeForCompare` is the identity — the tax is `node:path` string work and syscalls, not
case-folding.

The four losses vs isomorphic-git (`docs/understand/performance.md`, CI nightly `linux-x64`,
2026-08-13, ±20% runner variance):

| Scenario | tsgit/iso | Bench file |
|---|---|---|
| `status:clean` small | **0.45×** | `test/bench/status.bench.ts` |
| `status:clean` medium | **0.40×** | `test/bench/status.bench.ts` |
| `readBlob:cold-cache` small pack | **0.60×** | `test/bench/pack-read.bench.ts` |
| `readBlob:cold-cache` fresh repo (empty LRU) | **0.33×** | `test/bench/loose-read.bench.ts` |
| `delta-chain` cold | **0.35×** | `test/bench/delta-chain-read.bench.ts` |

`performance.md` currently concludes "the tax itself is inherent — iso-git skips the security check
entirely". That conclusion is what this design overturns: **git skips it too.** isomorphic-git's only
containment is `entry.path.includes('../')` on index entries; simple-git inherits git's model through
the binary. tsgit is stricter than the tool it replicates, and pays for it on every read.

`docs/design/checkcontainment-hot-path.md` explicitly foreclosed the fast-path lever and named its
re-entry condition: *"Lever 5c (trusted-internal-path fast-path) — security-boundary change, not
proposed …; returns only if a future profile shows containment **itself** dominating, as its own
security-reviewed proposal."* The committed profile now shows exactly that (0.46 of `status`
self-time). **This design is that proposal.**

## Requirements

Verifiable when this ships:

- **R1** — `NodeFileSystem`'s containment layer issues **zero** syscalls on a read-side access
  (`read`, `readSlice`, `readUtf8`, `stat`, `lstat`, `readdir`, `readlink`, `exists`,
  `openWithNoFollow(_, 'read')`) — the method's *own* syscall (the `read`, the `lstat`, the `readdir`,
  `exists`'s existence probe) is the operation, not the guard. The residual guard work is
  allocation-free on POSIX and awaits nothing once the root set has settled.
- **R2** — Every write-side surface (`write`, `writeStream`, `writeExclusive`, `writeUtf8`,
  `appendUtf8`, `mkdir`, `rm`, `rmRecursive`, `rename` (both arms), `symlink`, `chmod`,
  `openWithNoFollow(_, 'write')`) carries a symlink-aware guard on the path it acts on. No write
  surface loses that guard, and the two that are guarded by a *read-shaped* mode today (`chmod`,
  `rename` src) gain a write-shaped one. **One ratified exception (ADR-632):** `symlink`'s **target**
  argument loses ADR-051's containment gate — the target is opaque bytes written verbatim, as git
  writes them (§1.2 pin M). The link *path* keeps W1 + W2 like every other write surface.
- **R3** — Entry names reaching an index or a working-tree write are validated once, at the
  construction boundary, against git's pinned `verify_path` matrix (§1.1): `..`/`.`/empty/absolute,
  `.git` aliases including trailing-dot/space, NTFS `git~1` and `:`-stream forms, HFS
  ignorable-codepoint forms, and `.gitmodules`-must-not-be-a-symlink.
- **R4** — Every read-path refusal that disappears is enumerated with the git behaviour that makes its
  disappearance correct (§6), and every one that git *does* have is preserved — specifically
  `add <pathspec>` through a symlinked leading component, and the delete path's refusal to remove
  through a symlinked leading component.
- **R5** — Working-tree **content** reads never dereference a symlink leaf. **This is the sole
  defence against a planted hostile link, not one mitigation among several:** ADR-632 removes the
  creation-time target gate and §4.1 removes the read-time one, so nothing sits behind these call
  sites. The six sites, audited individually: `apply-changeset.ts:62`,
  `compare-working-tree-entry.ts:118` (ternary today), `snapshot/workdir-entry.ts:80` (ternary today),
  `blame.ts:184` (ternary today), `grep.ts:82`, `stash.ts:124` (ternary today). Each must reach
  `ctx.fs.read` only on a path it has already established is not a symlink; the four ternaries
  document the pattern the other two are measured against. Each of the six carries its own isolated
  test, and the discipline is pinned cross-adapter by ADR-629's parameterised contract rows.
- **R6** — The object store (`.git/objects`, alternates, a symlinked `objects` dir, a symlinked
  `.git`) is readable, matching git (§1.3 pins C/D/F).
- **R7** — The containment change's blast radius is the Node adapter. Memory and Browser/OPFS
  behaviour is unchanged. The two ratified performance slices (ADR-633's lazy walker stat, ADR-634's
  shared stat map, §10a) sit in the application layer and are adapter-agnostic: they change no
  adapter behaviour and no port contract, only the *number* of port calls a `status` issues.
- **R8** — `status:clean`, `readBlob:cold` (both) and `delta-chain:cold` move toward ≥1.0× on the CI
  nightly; no currently-winning scenario regresses beyond the advisory ±20% envelope.
- **R9** — 100% line/branch/function/statement coverage and zero surviving non-equivalent mutants on
  all new and changed code; no suppression directive of any flavour.
- **R10** — The two `Stryker disable next-line` equivalence proofs on `checkContainment`'s catch arms
  are re-proved against the new structure or removed with their arms. Carried-forward proofs are
  invalid once the structure changes.
- **R11** — A **lexically** outside path (`../outside`, an absolute foreign path, the prefix-only
  sibling `<root>-evil/x`) still throws `PERMISSION_DENIED` on **every** path-taking method, read and
  write. Verified by the shared port contract's existing 84-case security matrix staying green
  untouched, on both the Node and the Memory adapter.
- **R12** (ADR-634) — Within one `status` invocation, no repo-relative path is `lstat`ed by **both**
  the tracked pass and the untracked walk: for a working tree that does not change under the run, the
  two together issue at most one `lstat` per path. The one enumerated exception is a path whose first
  `lstat` *failed* — nothing is recorded, so a path created between the passes is sampled again, by
  design (§10a). Verified by call count against an injected filesystem, never by wall clock.
  `buildUnmergedEntries`'s per-unmerged-path `lstat` is deliberately outside the map — an unmerged
  path has no stage-0 entry, so the key sets are disjoint and a shared entry could never hit (§10a).
- **R13** (ADR-632) — Cloning a repository containing a symlink whose target is absolute
  (`link -> /etc/passwd`) or escaping-relative (`link -> ../../../etc/passwd`) writes the link
  **verbatim**, byte-identical to what `git clone` writes, with the target file untouched. Pinned in
  the interop tier against real git, not asserted from the adapter alone.

## Design

### §1 The pinned git model

**Probe environment** (all four probe scripts): `git version 2.55.0`, darwin arm64. Each probe runs in
its own `mktemp -d`, `HOME` redirected inside it, all `GIT_*` scrubbed, `GIT_CONFIG_NOSYSTEM=1`,
deterministic author/committer identity and dates, signing off. Observed defaults, unset in config:
`core.protectNTFS` `<unset>`, `core.protectHFS` `<unset>`, `core.symlinks` `<unset>`;
`core.ignoreCase` reads `true` (macOS). **Both protect flags are therefore ON by default on a
non-Windows, non-HFS host** — proved by the rejections below, not assumed.

#### §1.1 `verify_path` — index entry names

Probe: `git update-index --add --cacheinfo 100644,<blob>,<name>` in a fresh repo. `EXIT=128` +
`error: Invalid path '<name>'` = rejected; `EXIT=0` = accepted.

| Name | Verdict | Name | Verdict |
|---|---|---|---|
| `ok/file` | accept | `.git~1/config` | **accept** |
| `../escape` | reject | `git~1/config` | reject |
| `a/../b` | reject | `GIT~1/config`, `gIt~1` | reject |
| `a/../../b` | reject | `git~2`, `git~10`, `gi~1` | **accept** |
| `..` | reject | `git~1 `, `git~1.` | reject |
| `a/..` | reject | `.git::$INDEX_ALLOCATION` | reject |
| `./a`, `x/./y` | reject | `.git:x` | reject |
| `a/` (trailing sep) | reject | `.git\config` | reject |
| `a//b` | reject | `a\.git\b` | reject |
| `/abs/path` | reject | `a\b` | **accept** |
| `.git`, `.git/config` | reject | `nul`, `con`, `aux.txt` | **accept** |
| `.GIT/config`, `.Git/config` | reject | `x `, `x.`, `dir./x`, `dir /x` | **accept** |
| `.git.`, `.git `, `.git...` | reject | `. git`, `.gi t` | **accept** |
| `a/.git/config`, `sub/.git` | reject | `.gitmodules`, `dotgit` | **accept** |
| `a/git~1/b` | reject | `a<TAB>b` | **accept** |

Mode-dependent arm: `.gitmodules` at mode `100644` accept, `160000` accept, **`120000` reject**
(CVE-2018-11235 hardening). `.gitattributes` and `.gitignore` at `120000` **accept**. A gitlink
(`160000`) named `..` is rejected like any other entry.

HFS ignorable-codepoint scan, `.g<CP>it/config`:

| Codepoint | Verdict | Codepoint | Verdict |
|---|---|---|---|
| U+200C, U+200D, U+200E, U+200F | reject | U+202A, U+202E | reject |
| U+206A | reject | U+FEFF | reject |
| **U+2060** | **accept** | — | — |

Derived rules: the alias scan runs on **every** component; it splits on `/` **and `\`**; it strips
trailing `.` and ` ` before comparing; it is case-insensitive; it recognises exactly `git~1` (not
`git~2`, not `gi~1`, not `.git~1`) as the NTFS short name; it rejects a `:`-suffixed `.git`; it does
**not** reject bare `\`, Windows reserved device names, or trailing dots/spaces on non-alias names.

**Stage at which git applies it.** `git mktree` accepts `..`, `.git` and `git~1` (exit 0 — plumbing
escape hatch), and `git hash-object -t tree --literally` writes such a tree. The refusal fires when
the tree becomes an index:

```
$ git read-tree <tree with a '..' entry>      → error: invalid path '..'          exit=128
$ git clone --branch h <bare with hostile tree> <dir>
    error: invalid path '..'                       (also '.git', 'git~1', '.gi<ZWNJ>t')
    fatal: unable to checkout working tree
    warning: Clone succeeded, but checkout failed.  exit=128 — clone dir contains only .git/
```

Nothing partial is written: the whole checkout aborts.

#### §1.2 Symlink posture — read vs write

Working tree: `dir/file` tracked; `dir` replaced by a symlink to `$OUT` (outside the repo) or to
`inside` (a sibling directory in the repo).

| Command | Observed | `$OUT` touched? |
|---|---|---|
| `git status --porcelain` | ` D dir/file` + `?? dir`, exit 0 — no traversal, no error | no |
| `git status --porcelain -- dir/file` | ` D dir/file`, exit 0 | no |
| `git diff -- dir/file` / `git diff HEAD -- dir/file` | shows it as deleted, exit 0 | no |
| `git ls-files -- dir/file` | `dir/file`, exit 0 | no |
| `git ls-files -o -- dir/file` | empty, exit 0 | no |
| `git add -A` | exit 0 — stages `dir` as `120000`, `dir/file` as deleted | no |
| **`git add dir/file`** | **`fatal: pathspec 'dir/file' is beyond a symbolic link` exit=128** | no |
| `git add --dry-run dir/file` | same refusal, exit 128 | no |
| `git show HEAD:dir/file` | `good` — object read, unaffected | no |
| `git grep -I SECRET` (and `-- dir/file`) | no match, exit 1 | no |
| `git log --oneline -- dir/file` | history shown, exit 0 | no |
| `git checkout -f HEAD` / `git reset --hard` / `git checkout HEAD -- dir/file` — **pins G, I** | exit 0 — **symlink unlinked, real directory created, file written inside the repo**; identical for an intra-repo target (`dir -> inside`, which stays empty) | no, stays `PRISTINE` |
| `git checkout -f <branch that deletes dir/file>` — **pin L** | exit 0 — **removal skipped**, `dir` stays a symlink | no, stays `PRISTINE` |
| `git checkout <branch that deletes dir/file>` (unforced) | `error: Your local changes … would be overwritten`, aborts | no |

The `add` refusal is **shape-based, not containment-based**: it fires identically when the symlink
points *inside* the repo (a link to a sibling directory of the same repo, at any depth), and for a
file that is not tracked at all. It is the **only** command in the matrix that refuses.
`git checkout -- <p>` / `git restore -- <p>` / `git rm` / `git mv` / `git stash push -- <p>` all
decline for ordinary "pathspec did not match" reasons, never for the symlink.

Leaf symlinks (**pin B**): a link to `$OUT/secret` is staged as `120000` whose blob content **is the
target path** (`git cat-file -p :link` → `/…/outside/secret`) — git never dereferences it. Checking a
regular file out over that path unlinks the symlink and writes a regular file; the outside target's
bytes are unchanged. Cloning a repo containing a link to `/etc/passwd` **writes the symlink verbatim**
(**pin M**) — git does not validate symlink targets.

#### §1.3 Reads deliberately reach outside the repo

| Pin | Setup | Result |
|---|---|---|
| **C** | `.git/objects` moved out and symlinked back | `git cat-file -p HEAD:f` → `hi`; `git fsck` clean; `git log` fine |
| **D** | `.git/objects/info/alternates` → a donor repo outside | `git cat-file -p <donor oid>` → `donated` |
| **E** | Working dir reached through a symlink | `rev-parse --show-toplevel` → the **realpath** (`/private/var/…`) |
| **F** | `.git` itself moved out and symlinked back | `status` clean; `rev-parse --absolute-git-dir` → the outside path |

Two consequences. (a) An object store outside the repo is a **supported feature**, so a containment
gate on object reads is a bug, not a defence. (b) git canonicalises the worktree root **once at
discovery** — which is exactly ADR-042's lazy root realpath. Keeping the one-per-lifetime root
realpath is git-faithful; only the **per-access** realpath is not.

### §2 Target layering

```
caller path
  │
  ├─ facade validator (unchanged)      lexical: no `..` segment, prefix-in-any-root, allowlist
  │                                    → PATHSPEC_OUTSIDE_REPO
  │
  ├─ construction-time validation      verify_path parity at index/tree→index boundaries (§3)
  │   (new, domain layer)              → INVALID_INDEX_ENTRY
  │
  └─ NodeFileSystem
        read side   → lexical containment only, zero syscalls, zero allocations (§4.1)
        write side  → symlink-aware guard, amortised per directory (§4.2)
        object store→ nothing extra; alternates reachable (§5)
```

### §3 Pillar 1 — construction-time validation

#### §3.1 What exists

| Validator | File | Covers | Gap vs §1.1 |
|---|---|---|---|
| `validateIndexPath(path, offset): void` | `src/domain/git-index/path-validator.ts` | absolute, `.`/`..`/empty segments, `\` anywhere, C0/C1 controls, BIDI controls | **no `.git` alias, no NTFS `git~1`/`:`-stream, no HFS form, no mode-dependent `.gitmodules` arm**; rejects bare `\` where git accepts it |
| `validateWorkingTreePath(input): FilePath` + `isForbiddenGitComponent(component): boolean` | `src/domain/working-tree-path.ts` | non-empty, no leading `/`, no `\`, no NUL, no controls, no `.`/`..`/empty, no `:`, `.git` + trailing-dot/space forms, ≤4096 B path / ≤255 B component | **no NTFS `git~1`, no HFS form** |
| `parseTreeContent` (`src/domain/objects/tree.ts` L50) and `flatten-raw.ts` L172 | tree entry names | `''`, `.`, `..`, `/` | rejects at **tree parse**, where git rejects at **index write** |

Call sites: `index-parser.ts:99`, `synthesize-tree-from-index.ts:86` (defence-in-depth),
`walk-working-tree.ts:91`, `blame.ts:154`, `commands/internal/working-tree.ts:18`.

**The gap is load-bearing and pre-existing.** `.git` is *inside* the adapter's root set (`workDir`
contains it; `gitDir` is itself a root), so an index entry named `.git/hooks/pre-commit` is contained
and the
adapter has never refused it. Containment never defended this; `validateIndexPath` does not either.
Closing it is a net security gain that arrives with this change, not a cost of it.

#### §3.2 What to build

One total function in the domain, mirroring git's `verify_path(path, mode)`:

```ts
// src/domain/path/verify-path.ts  (new)
export type VerifyPathRejection =
  | 'absolute-path' | 'empty-segment' | 'dot-segment' | 'dotdot-segment'
  | 'dotgit-alias' | 'dotgit-ntfs-alias' | 'dotgit-ntfs-stream' | 'dotgit-hfs-alias'
  | 'gitmodules-not-regular';

export const verifyPath = (path: string, mode: FileMode): VerifyPathRejection | undefined;
export const isDotGitAlias = (component: string): boolean;   // §1.1 alias matrix, all four families
```

`verifyPath` returns a rejection reason rather than throwing, so each boundary can shape its own error
vocabulary (`INVALID_INDEX_ENTRY` with an offset, `PATHSPEC_OUTSIDE_REPO` for user input) without a
second parse. `isDotGitAlias` subsumes and replaces `isForbiddenGitComponent`, whose two consumers
(`walk-working-tree` skip, `validateWorkingTreePath` reject) both want the widened matrix.

Alias matcher shape (order matters, each arm proved by a §1.1 row):

1. Split the component on `/` **and `\`** (so `.git\config` is scanned as two components).
2. Strip trailing `.` and ` ` runs; lowercase.
3. `=== '.git'` → `dotgit-alias`.
4. `=== 'git~1'` → `dotgit-ntfs-alias` (exactly `~1`; `git~2`/`git~10`/`gi~1`/`.git~1` accept).
5. `startsWith('.git:')` → `dotgit-ntfs-stream`.
6. Drop the ignorable codepoints {U+200C–U+200F, U+202A–U+202E, U+206A–U+206F, U+FEFF} and re-test
   arm 3 → `dotgit-hfs-alias`. **U+2060 is not ignorable** (pinned accept) — the set is a closed
   literal list, never a range guess.

#### §3.3 Where it fires

Git's stage is the **index write**, not the tree read (§1.1). Matching that keeps `cat-file`/`show`
working on a hostile tree exactly as git does, and puts the refusal on every path that can become a
working-tree write:

| Boundary | File | Error |
|---|---|---|
| index file parse | `src/domain/git-index/index-parser.ts:99` (inside `validateIndexPath`) | `INVALID_INDEX_ENTRY` |
| tree → index | `src/application/primitives/build-index-from-tree.ts` | `INVALID_INDEX_ENTRY` |
| index → tree | `src/application/primitives/synthesize-tree-from-index.ts:86` | `INVALID_INDEX_ENTRY` |
| user pathspec | `validateWorkingTreePath` (already on `add`/`blame`/walk) | `PATHSPEC_OUTSIDE_REPO` |

Whether tree parse *also* validates is DC-3.

#### §3.4 The branded contained path — and its limit

The brief's "mint a branded contained path at the `join(root, verifiedRel)` boundary" is sound as a
**compile-time provenance proof** and unsound as a **runtime fast-path**: a TypeScript brand is
erased, so `NodeFileSystem` cannot distinguish a `ContainedPath` from any other `string` at run time
without a runtime-visible channel (a parallel port method, a wrapper object, or a second adapter
instance) — each of which either allocates per call or opens exactly the security hole ADR-541 closed.

The design therefore takes the honest route: **make the per-access check free rather than skippable**
(§4.1). The brand stays a domain-layer device that documents "this relative path passed `verifyPath`"
and is consumed by the join sites; it carries no runtime privilege. DC-2 records the alternative.

### §4 Pillar 2 — the read/write split in the adapter

#### §4.1 Read side — lexical, allocation-free, no syscall, no await

`ContainmentMode` loses its `read` and `lstat` members. What remains is a two-surface split:
`resolveRead(path): string` (sync, total, throws `PERMISSION_DENIED`) and
`resolveWrite(path): Promise<string>` (§4.2). Per read access, in order:

1. `toAbsolute` — `policy.isAbsolute(path)` is one `charCodeAt` on POSIX; the join arm is dead for
   internal callers, which all pass absolute paths.
2. A **non-allocating `..` prefilter**: `path.indexOf('..') === -1` in the common case. Only when `..`
   appears do we pay `policy.resolve` (whose rest array and result string are today paid on **every**
   access). The facade already rejects `..` segments, so this arm exists to keep a raw adapter
   fail-closed. Skipping `resolve` also stops collapsing `.` segments and duplicate separators — both
   are OS-normalised at the syscall and neither can escape, and a trailing separator still satisfies
   the `startsWith(root + sep)` arm, so no spurious refusal appears.
3. `policy.normalizeForCompare` — identity, zero allocation on POSIX.
4. `containedByPrefix` against each `RootPrefix` — one `===` plus one `startsWith`; N = 1 for a normal
   repo (ADR-541 minimises the set).

**Windows caveat (load-bearing).** Dropping `resolve` also drops the *foreign-separator*
normalisation the adapter contractually depends on: `joinPath` (`internal/join-working-tree-path.ts`)
emits `/` unconditionally, so a Windows caller legitimately hands in `C:\repo/sub/file`, which would
fail a `\`-separated prefix compare. The fix stays inside the case-folding step already paid there:
the Windows arm of `normalizeForCompare` additionally maps `/` → `\` (after the existing `\\?\`
strip and lowercase), and the roots are normalised through the same function, so both sides compare
like-for-like. POSIX is untouched and still allocation-free. The path handed to the syscall keeps its
mixed separators, which Win32 accepts.

**No await on the hot path.** `resolveRead` is *synchronous*: it reads the settled `RootSet` field
directly. Because the set is lazily canonicalised, each port method takes the shape
"sync fast arm, async slow arm on first use only" — an `async` accessor would reintroduce a microtask
per call even when it returns a settled value, which is what today's `private async resolveRootSet`
does at all ~17 call sites (P2). ADR-042's laziness and its reset-on-rejection rule are preserved.

Removed from the read side: `realpath` (1 syscall), `dirname` + `basename` + `join` (3 strings +
1 rest array), `resolve` (1 string + 1 rest array), the per-parent LRU probe, the microtask, and the
whole `isExactRoot` special case — the exact-root leaf needed a bespoke arm only because the lstat
mode trusted a *per-parent* verdict, and a direct lexical test on the path itself has no such blind
spot.

`exists` collapses to the same lexical gate plus the single `lstat` that answers the boolean, dropping
its `realpath`, its ENOENT re-check against the raw set (the one gate now runs before any I/O), and its
double root consultation. It is the largest read-side win by profile share (`exists` self: 0.27
name-rev, 0.23 describe, 0.16 log, 0.11 merge).

`readdir` keeps its one-per-directory gate; `walkWorkingTree` already pays containment per directory
there, and per entry at `visitEntry`'s `lstat` (see §8).

#### §4.2 Write side — symlink-aware, amortised per directory

The write guard keeps today's `creation` mechanism, renamed `write`, and gains the surfaces that a
read-shaped mode guards today. It has **two separable parts**, and not every write surface needs both:

- **(W1) Leading-path containment — every write surface.** `realpathForCreation`:
  `cachedParentRealpath(dirname)` (LRU-amortised per directory — git's `lstat_cache` equivalent) →
  `join(realParent, basename)`; ENOENT falls back to `realpathNearestExisting`. Cache invalidation
  unchanged (`rename` and `rmRecursive` clear; `rm` does not). Because W1 never realpaths the **leaf**,
  it preserves the property today's `lstat` mode was chosen for at `rm`: a **dangling** symlink, whose
  leaf realpath would ENOENT, is still removable.
- **(W2) Leaf no-follow — every surface that dereferences the leaf.** `write`, `writeStream`,
  `writeUtf8`, `appendUtf8`, `openWithNoFollow(_, 'write')` get it from `O_NOFOLLOW`. **`chmod` needs it
  too and cannot use `O_NOFOLLOW`**: POSIX `chmod` follows the leaf, so `chmod(link)` would re-mode a
  file outside the tree, and no portable no-follow chmod exists (the macOS-only variant is absent on Linux). `chmod` therefore keeps an explicit
  leaf `lstat` and refuses a symlink leaf — harmless for faithfulness, since git only ever chmods
  regular files (a `120000` entry carries no exec bit).
- `rm`, `rmRecursive`, `rename` (both arms) and `mkdir` carry **W1 alone**: unlink, rename and
  mkdir-over-an-existing-name all act on *the link itself* — the correct POSIX and git semantic, not an
  escape. `mkdir` over a symlinked directory succeeds like git's, and any later write *into* it is
  itself a W1-guarded access whose parent realpath is the symlink target.

W2's mechanism is **`O_NOFOLLOW` at the `open`** rather than `lstat`-then-write, where the platform
honours it: `writeFile(real, data, { flag: O_WRONLY|O_CREAT|O_TRUNC|O_NOFOLLOW })` refuses a symlink
leaf atomically (`ELOOP` → `PERMISSION_DENIED` via `mapErrno`'s existing arm), closing the TOCTOU
window between `interpretCreationLstat`'s `lstat` and the write **and** removing one syscall per write.
Windows ignores `O_NOFOLLOW` (already documented at `openWithNoFollow` L757): there the pre-write
`lstat` is retained, discriminated by `policy.caseInsensitive` exactly as `isSymlinkLeaf` is today.
`interpretCreationLstat` survives only as the Windows arm and as `chmod`'s explicit check — its
non-errno-rethrow and ENOENT contracts, and their four tests, are unchanged.

**Write-surface symmetry checklist** — every path-taking method on `NodeFileSystem`, its guard today
and after:

| Method | Today | After | Note |
|---|---|---|---|
| `read` / `readSlice` / `readUtf8` | `read` (realpath) | lexical (`resolveRead`) | R1 |
| `stat` | `read` (realpath) | lexical | follows symlinks by contract, as git does |
| `lstat` | `lstat` (parent realpath) | lexical | no follow at all |
| `readdir` | `read` (realpath) | lexical | one per directory |
| `readlink` | `lstat` | lexical | returns the target string; never dereferences |
| `exists` | inline realpath ×1–2 | lexical + 1 `lstat` | §4.1 |
| `openWithNoFollow(_, 'read')` | `lstat` | lexical | `O_NOFOLLOW` unchanged — the declared-nofollow surface, and what `pack-registry` holds per pack |
| **`openWithNoFollow(_, 'write')`** | `lstat` | **W1 + W2** | the `mode` argument now selects the guard; today both modes share one |
| `write` / `writeStream` / `writeUtf8` | `creation` | **W1 + W2** | `writeStream` pipes into `createWriteStream(real, { flags })` with numeric flags |
| `appendUtf8` | `creation` | **W1 + W2** (`O_APPEND\|O_NOFOLLOW`) | stricter than git for a symlinked reflog — pre-existing, see Out of scope |
| `writeExclusive` | `creation` | **W1 + W2** (`O_EXCL` already refuses any existing leaf) | lock files |
| `mkdir` | `creation` | **W1** | leading-symlink replacement is DC-6 |
| `rm` | `lstat` | **W1** | must not unlink through a symlinked leading dir (§1.2 pin L); W1's no-leaf-realpath keeps dangling links removable |
| `rmRecursive` | `lstat` + raw `removeTree` walk | **W1** on the root; `removeTree` unchanged (already `lstat`-per-node, never follows) | same |
| `rename` **src** | **`read` (realpath!)** | **W1** | bug fix, see below |
| `rename` **dst** | `creation` | **W1** | rename replaces the destination *name*; it does not follow it |
| **`chmod`** | **`read` (realpath)** | **W1 + W2 (explicit leaf `lstat`)** | chmod is a write *and* follows the leaf; a read-shaped guard leaves it unguarded on both counts |
| `symlink` (linkPath) | `creation` | **W1 + W2** (`symlink(2)` fails `EEXIST` on any existing leaf) | |
| `symlink` (absolute target) | `realpathNearestExisting` + root set (ADR-051) | **gate removed** — the target is written verbatim, absolute or relative alike (§1.2 pin M) | ADR-632; the target stops being validated at all, so `realpathNearestExisting` keeps only its W1 caller |
| `homedir` / `xdgConfigHome` / `systemConfigPath` | none | none | no path input |

**`rename` src is a live bug.** It resolves `realSrc = realpath(src)` and renames *that*. Verified with
Node directly: `renameSync('link', 'moved')` moves the **symlink** (POSIX semantics), while
`renameSync(realpathSync('moved'), 'moved2')` moves the **target** and leaves the link dangling. So
`mv <symlink> <dst>` today relocates the target file, not the link — divergent from git and from
POSIX. The no-follow write guard fixes it as a side effect (DC-9).

#### §4.3 Refusals git has that tsgit must keep or gain

| git behaviour (§1.2 pin) | tsgit today | After |
|---|---|---|
| `add <pathspec>` beyond a symbolic link → refuse | refuses **by accident**: the adapter's `lstat` throws `PERMISSION_DENIED`, which `src/application/commands/add.ts:149` and `:339` swallow via `.catch(() => undefined)`, degrading to `PATHSPEC_NO_MATCH` (`test/integration/node-shim.test.ts:282`) | an **explicit** leading-component `lstat` scan in `src/application/commands/internal/resolve-pathspec.ts` (the module `add`, `mv` and `blame` already share for `PATHSPEC_OUTSIDE_REPO`), memoised per directory across one pathspec set — git's `has_symlinked_leading_path` + `lstat_cache`. Shape-based, not containment-based: it fires for an intra-repo symlink too (§1.2). The two `.catch(() => undefined)` swallows go with it — a swallowed `PERMISSION_DENIED` is what made the current refusal accidental. Error shape is DC-4 |
| delete through a symlinked leading dir → skip the removal | adapter refuses via `lstat` mode's parent realpath | the write guard's parent realpath still refuses; git *skips silently*. DC-5 |
| write through a symlinked leading dir → unlink the symlink, create a real dir | adapter refuses (`PERMISSION_DENIED`) when the target resolves outside; writes **through** it when it resolves inside a root | the adapter refusal remains the backstop; git's unlink-then-create belongs at the command layer beside ADR-341's `rmIfExists`. DC-6 |
| `add -A` over a symlinked dir → store the symlink, don't traverse | already matches (`walk-working-tree.ts:92` skips a directory that is also a symlink) | unchanged |
| leaf symlink → store `readlink` output as blob content, never dereference | matches (`add.ts:407`) | unchanged; R5 audits the six generic working-tree read sites for the same discipline |

### §5 Pillar 3 — object-store read exemption

Loose paths are built as `looseObjectPath(commonGitDir(ctx), id)` from a branded `ObjectId` whose hex
is already validated — traversal is impossible by construction. Pack artefact paths come from a
`readdir` of `objects/pack`. Under §4.1 no read carries a realpath, so the exemption needs **no
special case**: it is the absence of one. Two active consequences:

- **Alternates and a symlinked `objects` dir become readable** (§1.3 pins C/D), where today the
  post-realpath check refuses anything resolving outside the root set. tsgit does not yet read
  `objects/info/alternates`; this removes the blocker rather than implementing the feature.
- `pack-registry.ts:372` holds a persistent per-pack handle via `openWithNoFollow(packPath, 'read')`
  (ADR-510, shipped). Its containment becomes lexical; `O_NOFOLLOW` on the pack file stays.
- ADR-509's loose-first precedence and its readdir-backed fanout membership set are untouched. The
  probe ordering was surveyed and **no change is proposed** (§10, P8).

### §6 Read-path refusals that disappear

**The invariant that survives, stated first, because it bounds everything below:** a **lexical** escape
is still refused on **every** surface, read and write — a path outside every root prefix (`../outside`,
an absolute foreign path, the prefix-only sibling `root-evil`) throws `PERMISSION_DENIED` exactly as
today. What disappears is only the **post-realpath** stage: an in-root path whose *resolution* lands
outside. Every refusal below is of that second kind.

| Refusal removed | Why git-parity makes it correct |
|---|---|
| `read`/`readUtf8`/`readSlice` through a symlink resolving outside every root | git reads through symlinks freely; it never dereferences a *working-tree* symlink for content (it `readlink`s it), and the paths it does dereference (`.git/config`, objects, alternates) are deliberately allowed outside (§1.3). The anti-dereference property moves to the callers (R5) where git keeps it |
| `stat` / `readdir` of a symlinked-outside path | `git status` neither traverses nor errors on a symlinked directory (§1.2); it reports the symlink |
| `lstat` of a leaf under a symlinked parent | git lstats through a symlinked leading path all day; the only place it *refuses* is `add`'s pathspec, which §4.3 preserves explicitly |
| `readlink` under a symlinked parent | reading a link's target is not an escape — the target is opaque bytes, exactly what git stores as the blob |
| `exists` of an **in-root** path whose realpath (or 8.3 expansion) lands outside | probe-only, and a probe that answers "yes, and it resolves elsewhere" is the same information `lstat` now gives. An `exists` of a **lexically** outside path still refuses |
| Windows 8.3-alias escapes (a short-name path whose long-name expansion leaves the roots) | same class: it was a post-realpath refusal. The *reconciliation* direction — a short-name input matching a canonical long-name root — is retained (§9) because it prevents a false denial |
| `rename` **src** leaf realpath escape | subsumed: the src arm stops following the leaf at all, which is both the POSIX and the git semantic |
| object-store reads outside the root set | supported git feature (§1.3, R6) |

One **write**-side refusal disappears too, and it is the only one: ADR-632 removes ADR-051's
absolute-symlink-**target** gate, so `symlink('/etc/passwd', <in-root link>)` now succeeds and writes
the link verbatim, exactly as git does (§1.2 pin M). It is listed here rather than above because it
is neither a read nor a post-realpath refusal — it is a deliberate, user-ratified write relaxation,
and R5 is what stands behind it.

Preserved unchanged: **every** `PERMISSION_DENIED` on a write escape of the path being written (R2 —
the symlink *target* being the single ratified exception above), the facade's
`PATHSPEC_OUTSIDE_REPO` layer, `ADAPTER_UNAVAILABLE`/errno mappings, `readSlice`'s negative-argument
refusal, the Memory adapter's lexical containment, and the Browser adapter's per-segment `'..'`
refusal.

### §7 Threat model (mandatory)

#### §7.1 What each pillar stops defending, and what still defends it

| Pillar | Stops defending | What still defends it |
|---|---|---|
| 1 (construction-time) | nothing — it *adds* defence (the `.git`-alias/NTFS/HFS gap in `validateIndexPath`, §3.1) | — |
| 2 (writes only) | reading outside the roots via a symlink | (a) the facade's lexical layer for every Context-routed path; (b) the adapter's lexical layer even for raw adapters; (c) caller-side `isSymbolicLink` branching on working-tree content reads (R5) — **the only layer that sees the symlink at all**; (d) `add`'s explicit leading-symlink refusal (§4.3); (e) the OS, for anything the process itself may not read |
| 3 (object store) | nothing new — reads were already unguarded by pillar 2 | OID-hex construction makes traversal unrepresentable |
| ADR-632 (symlink targets) | refusing to *create* a link whose absolute target escapes the roots | (c) alone. Nothing else inspects a link target: the adapter writes it verbatim, and no read-side layer resolves it |

The list above used to carry ADR-051's creation-time target gate between (d) and the OS item.
ADR-632 removes it, so **(c) carries the whole load** for the planted-link class: a hostile link can now be created
and cloned, and the only thing standing between it and a dereference is a working-tree content reader
that checks `isSymbolicLink` first. That is git's own posture — git validates no symlink target
either — and it is why R5's audit is exhaustive and per-site rather than a spot check.

#### §7.2 Read vs write asymmetry — why it is defensible

A read escape leaks bytes the *calling process already has permission to read*; a write escape
mutates state outside the repository. git accepts the first (it cannot both support alternates and
refuse outside reads) and defends the second — pinned, not recalled: it unlinks a symlinked leading
component before writing (pins G/I), skips a removal whose leading component is a symlink (pin L), and
refuses hostile names at every index write (§1.1). The asymmetry is not a convenience: it is the shape
of the threat. tsgit's extra read gate bought no defence against a
*malicious repository author* — the author controls the working tree the caller cloned — while
costing 0.46 of `status` self-time on every honest read.

#### §7.3 Hostile-repo scenarios

External config paths (`~/.gitconfig`, `$XDG_CONFIG_HOME/git/config`, `/etc/gitconfig`) are **not**
affected: they sit outside every layout root (`layoutRootsOf` = `{workDir, gitDir, commonDir}`, no home
entry), so the lexical gate returns the same verdict before and after. The facade's `allowExternalPaths`
allowlist admits them at its layer only; `internal/config-scope.ts`'s `exists` helper swallows every
error while its `safeReadUtf8` swallows only `FILE_NOT_FOUND`. Unchanged by this design, noted so the
implementer does not read a behaviour change into it.

| Scenario | git | tsgit after | Residual |
|---|---|---|---|
| Tree entry named `..`, `/abs`, `.git/config`, `git~1`, `.gi<ZWNJ>t` | refuses at index write; nothing checked out (§1.1) | same, via `verifyPath` at the same stage (§3.3) | none |
| `.gitmodules` as a symlink | refuses (mode arm) | same | none |
| Working-tree entry is a symlink to `/etc/passwd` (absolute) | stores/writes the link; never dereferences | same — **the link is written verbatim** (ADR-632), `add` stores the target as blob bytes, the target file is untouched | **R5 is the line.** A caller doing a blind `ctx.fs.read` would dereference; nothing behind it refuses |
| Working-tree entry is a symlink to `../../../etc/passwd` (relative) | same | same — **the link is written verbatim**; absolute and relative targets are now treated identically (ADR-632 removed the only distinction) | **R5 is the line**, identically. Both arms of this pair now have exactly one defence and it is the same one |
| Symlinked leading directory, then `add dir/file` | `fatal: … beyond a symbolic link` | explicit refusal (§4.3) | none |
| Symlinked leading directory, then checkout writes `dir/file` | unlinks the symlink, writes inside | adapter refuses (backstop) / command unlinks (DC-6) | a divergence either way until DC-6 lands; never a write outside |
| Symlinked leading directory, then checkout *deletes* `dir/file` | skips the removal silently | write guard refuses (DC-5) | no outside deletion in either shape |
| `.git/objects` or `.git` symlinked outside | supported | supported (R6) | by design |
| `.git/config` symlinked to a file outside | git reads it | tsgit reads it | parity; "don't open untrusted repos" is git's posture too |

#### §7.4 TOCTOU windows

| Window | Today | After |
|---|---|---|
| write: `interpretCreationLstat`'s `lstat` → `writeFile` | open (a symlink planted in between is followed) | **closed** on POSIX by `O_NOFOLLOW` in the same `open`; unchanged on Windows (documented platform limit) |
| write: `cachedParentRealpath` → the write | open; an external writer can swap a parent directory for a symlink after the verdict is cached. Recorded as out-of-scope in `linked-worktree-discovery.md`; ADR-541 explicitly does not widen it | unchanged — same window, same scope. Narrowing it needs `openat`/`O_DIRECTORY` handle-relative I/O, which Node does not expose |
| `add`: walk `lstat` → stage read | closed by `add.ts:356`'s re-`lstat` under the index lock | unchanged; the new leading-symlink scan sits before it and is subject to the same class of window, exactly as git's `lstat_cache` is |
| `openWithNoFollow`: `isSymlinkLeaf` → `open` | Windows-only pre-check + post-error discriminator | unchanged |

#### §7.5 Fail-closed properties retained

An empty root set still throws at construction (`UNSUPPORTED_OPERATION`). A root-set resolution
failure still clears the memo and rethrows. The facade still fails closed when its root list sanitises
to empty. `unsafeRawAdapters: true` still bypasses only the facade layer, never the adapter's lexical
gate.

### §8 Blast radius per adapter

| Adapter | Containment today | Change | Why |
|---|---|---|---|
| **Node** | realpath, three modes | **all of §4** | the only symlink-aware layer, and the only one paying syscalls |
| **Memory** | lexical only — `MemoryFileSystem.resolve` rejects a path that is not `rootDir` or under `rootDir + '/'`; construction rejects pre-seeded outside paths; 40-hop symlink follower (`SYMLINK_FOLLOW_LIMIT`, POSIX `SYMLOOP_MAX`) | **none** | its root confinement *is* its addressing model (paths are map keys); the check is a string compare, so there is no tax to recover, and relaxing it would only admit unreachable keys |
| **Browser/OPFS** | origin-sandboxed by the browser; only a per-segment `'..'` refusal; `symlink` throws `UNSUPPORTED_OPERATION` | **none** | cannot escape OPFS; has no symlinks to defend against |

R7 confirmed: **Node-adapter-scoped.** The shared port contract's existing security matrix is
unaffected (it exercises lexical escapes only, which both adapters still refuse); the *new*
asymmetry — Node allows a symlink read escape where Memory's 40-hop follower still refuses one — is
what DC-7 decides how to pin.

### §9 Windows specifics

- 8.3 short-name reconciliation stays where it is: the root set holds both the raw and the canonical
  prefix (`RootSet.all`), so a caller passing `C:\Users\RUNNER~1\…` still matches a canonical
  long-name root. ADR-042's mechanism is untouched; only the per-access realpath goes.
- `\\?\` extended-length prefix stripping stays in `normalizeForCompare` (`path-policy.ts`
  `stripWinExtendedPrefix`, UNC arm first).
- `verifyPath` covers the NTFS aliases of `.git` — `git~1` (case-insensitive, trailing-dot/space
  stripped) and the `:`-stream forms — on **every** platform, because git's `core.protectNTFS`
  default is ON everywhere (§1.1, proved on darwin). The check belongs in the platform-independent
  domain layer, not in the Windows-only branch of the adapter, since the hostile index/tree can be
  cloned onto a POSIX host and later shared with a Windows one.
- `O_NOFOLLOW` is ignored by Win32; the write path keeps the `policy.caseInsensitive`-gated pre-`lstat`
  there. This is a platform limit, recorded, not a divergence from git (git's own protections there
  rest on `verify_path`, which §3 replicates).

### §10 Performance survey

In-scope slices (each falls out of §4, none is speculative):

| # | Slice | Mechanism | Expected effect |
|---|---|---|---|
| P1 | Drop the read-side realpath | §4.1 | Exact, per mode: **`read`-mode** surfaces (`read`, `readSlice`, `readUtf8`, `stat`, `readdir`, `chmod`'s old arm) lose **one syscall** (the full `realpath`) per access. **`lstat`-mode** surfaces lose **no syscall on a parent-cache hit** — the win there is pure CPU (the 0.46 self-share: `containmentVerdict`, `isContainedInEitherRoot`, `dirname`, `basename`, `checkContainment`) plus one `realpath` per cache miss. `status:clean` is entirely the second kind, which is why its loss is a CPU loss |
| P2 | Synchronous `resolveRootSet` | return the settled `RootSet` from a sync accessor; `async` only on first use | removes one microtask per FS call across ~17 call sites |
| P3 | `..` prefilter instead of unconditional `policy.resolve` | §4.1 step 2 | removes 1 rest array + 1 string per access |
| P4 | No `dirname`/`basename`/`join` on the read side | §4.1 | removes 3 strings (+1 rest array) per access; kills the `dirname 0.06` / `basename 0.04` frames on `status` |
| P5 | `exists` → lexical + one `lstat` | §4.1 | Same syscall *count* (a probe must probe), but swaps a full `realpath` (resolves every component) for one `lstat`, and drops the second root consultation and the ENOENT re-check. Targets the largest single read-side frame (`exists` self 0.27 name-rev, 0.23 describe, 0.16 log, 0.11 merge) |
| P6 | One fewer syscall per write | `O_NOFOLLOW` replaces the pre-write `lstat` on POSIX (§4.2) | helps clone/checkout write volume; also closes a TOCTOU |
| P7 | `rootOf` without a full `ParsedPath` | `path-policy.ts` `rootOf` allocates a `ParsedPath` to read `.root`; only `realpathNearestExisting` uses it | micro; write path only |
| P9 | `walkWorkingTree`'s per-entry `lstat` (`walk-working-tree.ts:103`) — **in scope per ADR-633** | derive is-file/is-dir/is-symlink from the `readdir` batch `walkInternal` already has, and expose the `FileStat` as a lazy per-entry fetch | one `lstat` **and** one `joinPath` saved per walked entry for every stat-free consumer — which is exactly `status`'s untracked pass (`status.ts:206` binds `{ path }` only). Direct `status:clean` contribution |
| P10 | `status`'s double `lstat` per tracked path — **in scope per ADR-634** | one per-invocation stat map shared by the tracked pass and the untracked walk (§10a) | With P9 landing in the same change, `status`'s untracked pass already stops stating, so the map's *measured* saving on `status:clean` is small. What it buys is that **≤1 `lstat` per path per invocation becomes structural** (R12) rather than an accident of which fields the untracked consumer happens to destructure, and it pays in full the moment either pass does need the sample. Verified by call count, not wall clock |

Surveyed and **not** proposed, with the reason:

| # | Candidate | Verdict |
|---|---|---|
| P8 | Loose-before-pack probe reordering | **Rejected twice already** — by `checkcontainment-hot-path.md`'s own DC-7 (that doc's numbering, not this one's) and by ADR-509, both against an empirical pin that git is loose-first (`git cat-file` on a corrupt-loose/valid-pack pair emits the inflate error, then serves the pack). No change |
| P11 | Persistent per-pack `FileHandle` | Already shipped (`pack-registry.ts:372`, ADR-510). No action |
| P12 | `parentRealpathCache` sizing (512 / 128 KiB) | Now write-path-only; the 256-fanout thrash argument that set 512 was a *read*-path (loose probe) argument. Re-sizing is behaviour-neutral and can ride along, but has no measurable read-path effect once P1 lands. No separate slice |

Acceptance signal (R8) is the CI nightly `bench.yml` artefact on the four losing scenarios, at ±20%
advisory variance — never a local run. Note the gate asymmetry: `hot-paths.json` covers `status` and
`pack-read`, so `loose-read` (0.33×) and `delta-chain-read` (0.35×) are **ungated** by
`benchmark-compare` and must be read off the nightly by hand.

Honest expectation per scenario (R8): `status:clean` is dominated by the per-entry containment share
and should move the most — and it is now the only scenario carrying **three** independent
contributions, P1's containment collapse plus P9's per-entry `lstat`/`joinPath` removal and P10's
one-sample-per-path invariant. P9 is the measurable half of that pair; P10 is measured by call count
(R12) rather than by the bench, so a `status:clean` result must not be read as evidence for or
against it. `readBlob:cold` and `delta-chain:cold` are dominated by **repository-open fixed cost**
(discovery, pack-registry load, `.idx`/`.rev`/midx probes) of which containment realpaths are one
component per artefact probe — the win is real but bounded by the rest of the open path, and P5's
`exists` collapse is the largest single contributor there. Neither is touched by P9/P10: they open a
repository and read objects, they do not walk the working tree.

### §10a `status`'s shared stat map (ADR-634)

DC-12 recommended deferring this; the user ruled it into scope, so it needs a design rather than a
pointer. The shape below is the smallest thing that satisfies ADR-634's decision — *whichever pass
stats a path first records the result, the other consumes it* — without inventing a cache.

**The collection.** One first-class, per-invocation accumulator, not a bare `Map` handed around:

```ts
// src/application/commands/internal/working-tree-stat-map.ts  (new)
export interface WorkingTreeStatMap {
  readonly sampled: (path: FilePath) => FileStat | undefined;   // query
  readonly record: (path: FilePath, stat: FileStat) => void;    // command
}
export const createWorkingTreeStatMap = (): WorkingTreeStatMap;
```

CQS-split on purpose: `sampled` never populates, `record` never returns. It is mutable state, and the
containment on that is lifetime, not immutability — it is created inside one `status` call, passed
explicitly down two call paths, and unreachable once `status` returns. Same shape as the walker's
existing `Counter` and `status`'s own `workingMap`; no module-level state, no `Context` field, no
adapter cache (ADR-634 rejected option (c) for exactly that reason).

**Where it lives and how it is threaded.** `status` creates it once, beside the attribute provider,
and hands the *same* instance to both passes:

| Site | Today | With the map |
|---|---|---|
| `status.ts` orchestration | — | `const stats = createWorkingTreeStatMap()` before `scanWorkingTree`; passed to both passes |
| `compareWorkingTreeDelta` (`compare-working-tree-entry.ts:90`) | `await ctx.fs.lstat(absPath).catch(() => undefined)` | `stats?.sampled(entry.path) ?? await lstat(…)`, then `stats?.record(entry.path, stat)` on a successful sample |
| `walkWorkingTree` → ADR-633's lazy per-entry stat | `visitEntry` lstats eagerly | the lazy accessor consults `stats?.sampled(path)` before issuing its `lstat`, and records what it does fetch |

Both parameters are **additive and optional** — a 5th optional argument on `compareWorkingTreeDelta`
and a new `stats?` field on `WalkWorkingTreeOptions`. Both functions are public exports (they are in
`reports/api.json`), so the wiring is deliberately *not* a signature refactor: collapsing
`provider`/`indexMtime`/`stats` into one options object would read better but is a **breaking**
public-signature change on a 3.x library for an internal convenience. Additive keeps **this wiring**
non-breaking and the api.json regen a gate rather than a bump; ADR-633's lazy entry shape is a
public-shape change of its own and carries that question separately. Absent the map — every other
`compareWorkingTreeDelta` consumer (`rm`, `stash`, clean-work-tree, apply-merge via
`compareWorkingTreeEntry`) and every other walker consumer (`add`, `stash`, the snapshot
enumerator) — behaviour and call counts are byte-for-byte what they are today.

**Interaction with ADR-633.** The two slices compose in one direction: ADR-633 makes the walker's
stat *lazy*, ADR-634 makes it *deduplicated*. The lazy accessor is precisely the injection point —
whatever shape ADR-633's implementation gives it, it is the single place the walker can issue an
`lstat`, so consulting and populating the map there covers the whole walk. Two consequences worth
stating because they look like contradictions otherwise:

- In `status` specifically, ADR-633 alone already removes the second `lstat`, because the untracked
  pass binds `{ path }` and never asks for the stat. The map does not add a saving on top of
  that; it makes the invariant hold **regardless of what a consumer asks for**, which is what R12
  pins and what a future untracked consumer that does read the stat inherits for free.
- The accessor must memoise its own fetch per entry as well, so that two calls from one consumer
  issue one `lstat` even when no map is supplied. That is ADR-633's concern, not this one, but the
  two must not each assume the other does it.

**Order independence.** `status` awaits `scanWorkingTree` fully before `scanUntracked` starts, so
today the tracked pass always records and the walk always consumes. The map is written
order-agnostically anyway (ADR-634's wording), which costs one lookup on a guaranteed miss and buys
correctness if the pass order ever changes. Within pass 1 the entries are concurrent
(`Promise.all`) but stage-0 paths are unique, so no two in-flight calls contend for one key — the map
needs **no** single-flight promise memoisation. If the two passes are ever made to overlap, it would;
this design does not overlap them.

**Absent files record nothing.** `compareWorkingTreeDelta` treats a failed `lstat` as `absent`. The
map stores successful samples only — no tombstones. A tombstone would need invalidating by anything
that later creates the path, and it could never be consumed usefully anyway: the walk only yields
paths that exist. The one observable consequence is that a file created between the two passes gets a
fresh stat from the walk instead of a stale negative, which is more accurate, not less.

**Keying and case.** Keys are repo-relative `FilePath` values, compared byte-exact — the same key both
passes already carry (`entry.path`, and the walker's `joinPathSegment` result). No case folding: on a
case-insensitive filesystem two spellings of one file miss each other and cost one extra `lstat`.
That is a missed optimisation, never a wrong sample, and folding here would silently diverge from the
byte-exact path identity the index itself uses.

**Staleness — the full statement.** Today the two passes take two independent samples of the same
path at two different times; both already race the working tree. Consuming one sample twice **removes
the second sample**; it does not add a new race class, and it narrows rather than widens the window
in which the two views of a path can disagree. The consumed sample can be up to one pass older than a
fresh `lstat` would be — which is what git's own `status` does, stating each path once per run via
`lstat_cache`. No `status` verdict depends on the delta between the two samples: `changes` are derived
entirely from pass 1's sample and `untracked` entirely from pass 2's path set. The stat-cache fast
path (`isEntryStatClean` / `ie_match_stat`, armed only when `status` supplies `indexMtime`) is
**unchanged** — it still compares the same fields of the same sample against the same racy-guard
reference point, and it fires before any of this on a clean entry.

**Memory.** Bounded by the number of paths one `status` already materialises in `workingMap` and
`untracked` — the same order as the index. No eviction policy is needed or wanted; adding one would
reintroduce the cache ADR-634 rejected.

### §11 Superseded and refined

| Artefact | Disposition |
|---|---|
| [`docs/understand/security.md`](../understand/security.md) §"Path containment" — *"Every `FileSystem` adapter enforces that every input path resolves to a location inside one of the adapter's containment roots"*, the three-mode realpath table, and *"symlinks pointing outside every root … throw `PERMISSION_DENIED`"* | **Superseded** for the Node adapter's read side **and for symlink targets on the write side** (ADR-632). Must be rewritten to the read/write asymmetry and to "a link's target is never validated", keeping the Memory and Browser paragraphs as-is |
| [`docs/understand/performance.md`](../understand/performance.md) — *"The tax itself is inherent — iso-git skips the security check entirely"* (and the "extra `lstat` / path-policy step per path" paragraph) | **Superseded**: git skips it too; the check was stricter than the tool being replicated. Note the file is already modified in the working tree by this branch's docs work — coordinate, do not clobber |
| [`docs/use/errors.md`](../use/errors.md) — the documented `PERMISSION_DENIED` trigger conditions | **Refined**: write escapes and lexical escapes keep the code; post-realpath read escapes no longer raise it |
| [**ADR-042**](../adr/042-canonical-root-lazy-realpath.md) (lazy canonical-root realpath) | **Refined**, not superseded — the one-per-lifetime root realpath is retained and is git-faithful (§1.3 pin E). Its "one `await` on the hot path is negligible" consequence is revised: the accessor becomes synchronous (P2) |
| [**ADR-541**](../adr/541-raw-node-adapter-layout-root-set.md) (adapter confined to the layout root set) | **Refined** — the root *set* survives and matters more for the write path. Its rationale ("the adapter's realpath check is the only symlink-aware containment layer") is **superseded on the read side**: there is deliberately no symlink-aware read layer after this change, and the exploit it cites (`pathspec … is beyond a symbolic link`) is preserved where git actually raises it, in `add` (§4.3) |
| [**ADR-485**](../adr/485-status-clean-containment-tax-amortisation.md) (amortise the containment tax, verdict unchanged) | **Refined** — the verdict now changes on the read side; the amortisation machinery it introduced (precomputed prefixes, single child-normalise) is retained and the per-parent verdict cache narrows to the write path |
| [**ADR-051**](../adr/051-symlink-target-containment.md) (symlink target containment) | **Superseded by [ADR-632](../adr/632-symlink-targets-written-verbatim.md)** — the user ratified git parity over this design's recommendation to keep it. The absolute-target gate is removed, its `realpathNearestExisting` + root-set call goes with it, and its tests are retired rather than re-pointed. Absolute and relative targets are now treated alike: opaque bytes, written verbatim (§1.2 pin M, §4.2, §7.3). tsgit can clone every repository git can clone; R5 is what holds the line behind it |
| [**ADR-509**](../adr/509-loose-first-precedence-with-loose-oid-cache.md) (loose-first) / [**ADR-510**](../adr/510-persistent-per-pack-file-handles.md) (persistent pack handle) / [**ADR-340**](../adr/340-consolidate-mode-aware-working-tree-writers.md) / [**ADR-341**](../adr/341-always-unlink-before-regular-working-tree-write.md) (shared working-tree writer) | Untouched; ADR-341's `rmIfExists` is what makes the adapter's write refusal a backstop rather than a divergence |
| [`checkcontainment-hot-path.md`](./checkcontainment-hot-path.md)'s foreclosure of "Lever 5c" | **Re-entry condition met** (containment itself dominates the committed profile). Its two `Stryker disable` equivalence proofs on `checkContainment`'s catch arms are structure-specific and must be re-proved or removed with their arms (R10) |
| [**ADR-226**](../adr/226-git-faithfulness-prime-directive.md) (prime directive) | The authority for the change: this moves *toward* git, not away |

## Decision candidates — all settled

Every candidate went to the ADR conversation and carries a decision; nothing below is open. The
**Disposition** column names the ADR and the ratified option; **DC-10 and DC-12 deviate** from this
design's recommendation and their rows record the ratified reasoning, not the superseded one. The
**Why** column is retained as written for the eleven adopted-as-recommended rows — it is the argument
the ADR adopted; the ADRs carry the condensed form.

| # | Choice | Alternatives (≤3) | Disposition | Why |
|---|---|---|---|---|
| DC-1 | Read-path leaf-symlink posture | (a) lexical only, zero syscalls (git parity); (b) `lstat` the leaf and escalate to `realpath` only when it is a symlink (the brief's pillar-2 wording); (c) `O_NOFOLLOW` on every read `open` | **[ADR-625](../adr/625-git-parity-containment-posture.md)** · adopted as recommended — **(a)** | (b) keeps a syscall on every read — an `lstat` in place of a `realpath` — so the read-side syscall count is unchanged and only the string work is recovered; for `readBlob:cold` and `delta-chain:cold`, whose cost is syscalls on a per-call repository open rather than per-entry CPU, that is the smaller half of the tax and puts R8 at risk. It also still does not stop a symlinked *leading* directory, so the guarantee it buys is partial. (c) diverges from git, which reads symlinked files (`.git/config`, `.git/objects`) as a feature, and would break `stat`'s follow contract. (a) is what git does; the leaf-dereference property is preserved where git preserves it — in the callers (R5) and in `openWithNoFollow` |
| DC-2 | Runtime-visible trusted-path channel | (a) none — one free lexical check for every path; (b) branded `ContainedPath` + parallel port methods that skip the check; (c) a second, unguarded adapter instance for internally-constructed paths | **[ADR-625](../adr/625-git-parity-containment-posture.md)** · adopted as recommended — **(a)** | The brand is erased at run time (§3.4), so (b) needs a real parallel surface: 21 methods × 2, and the moment any caller passes an unvalidated string into the trusted arm the gate is gone. (c) is precisely the rooting hole ADR-541 closed. (a) costs one `===` plus one `startsWith` — the same order as isomorphic-git's own check |
| DC-3 | Where `verifyPath` fires | (a) index-write boundaries only (`parseIndex`, `buildIndexFromTree`, `synthesizeTreeFromIndex`) + the existing pathspec validator; (b) also at tree parse (`parseTreeContent`, `flatten-raw`); (c) only at the working-tree write boundary | **[ADR-625](../adr/625-git-parity-containment-posture.md)** · adopted as recommended — **(a)** | (a) is git's own stage (§1.1: `mktree` accepts, `read-tree`/`clone` refuse), so `cat-file`/`show`/`log` keep working on a hostile tree exactly as git does. (b) would make tsgit refuse to *inspect* a tree git happily prints — a new divergence, and note tsgit's tree parser is already stricter than git for `..`. (c) leaves `write-tree` able to mint a `.git`-aliased tree |
| DC-4 | Error shape for `add <pathspec>` beyond a symbolic link | (a) a new `PATHSPEC_BEYOND_SYMLINK` code carrying the pathspec; (b) keep today's observable `PATHSPEC_NO_MATCH`; (c) `PERMISSION_DENIED` | **[ADR-626](../adr/626-pathspec-beyond-symlink-error-code.md)** · adopted as recommended — **(a)** | git has a dedicated `fatal` for it, and it is a distinct condition callers may want to branch on. (b) is today's *accidental* shape — it comes from `add.ts:149`/`:339` swallowing the adapter's `PERMISSION_DENIED` in a `.catch(() => undefined)`, which is a swallowed error the guardrails forbid; making it deliberate requires the new check anyway. (c) reuses a code whose meaning is "containment escape", which this is not (it fires for intra-repo symlinks) |
| DC-5 | Delete through a symlinked leading directory | (a) skip the removal silently, like git (§1.2 pin L); (b) refuse with `PERMISSION_DENIED`; (c) leave `rm`/`rmRecursive` on today's `lstat` mode | **[ADR-627](../adr/627-delete-through-symlinked-leading-directory-skips.md)** · adopted as recommended — **(a)** | (a) is the pinned git behaviour (`checkout -f` to a branch that deletes the path exits 0, leaves the symlink, and does not touch the outside file). (b) is safe but noisier than git and would break a forced checkout that git completes. (c) is unsafe after the read relaxation: `lstat` mode without its realpath would *delete outside the tree* |
| DC-6 | Write through a symlinked leading directory | (a) adapter keeps the parent-realpath refusal as a backstop; command layer unlinks the symlinked component first, beside ADR-341's `rmIfExists`; (b) the adapter itself unlinks a symlinked leading component during `mkdir`; (c) adapter backstop only, command-layer parity deferred | **[ADR-628](../adr/628-checkout-unlinks-symlinked-leading-component.md)** · adopted as recommended — **(a)** | git unlinks and creates a real directory (§1.2 pins G/I), including for an intra-repo symlink — and tsgit today diverges in *both* sub-cases (refuses when the link points out, writes *through* it when it points in). (b) puts working-tree policy in the adapter, which cannot know whether the caller is a checkout or an arbitrary write. (c) leaves a known divergence in the pillar the brief says must stay faithful |
| DC-7 | Symlink-escape rows in the **shared** port contract. The existing 84-case `security matrix` stays green untouched (both its inputs are lexical), so the only question is whether the *new* divergence — Node allows a symlink read escape, Memory's follower still refuses one — gets a shared row | (a) leave the shared contract alone; pin the Node behaviour in the Node files and the Memory behaviour in the Memory files; (b) add parameterised symlink rows to the contract, with the expected outcome supplied per adapter through `FileSystemContractEnv`; (c) add the rows and relax Memory so one expectation fits both | **[ADR-629](../adr/629-shared-contract-parameterised-symlink-rows.md)** · adopted as recommended — **(b)** | The divergence is now a deliberate, documented property of the two adapters, and a shared row is where a future adapter (or a future Node regression) gets caught — the contract already carries `getRootDirSibling` for exactly this kind of per-adapter input. (a) leaves the most security-relevant asymmetry in the library unpinned cross-adapter. (c) changes an adapter with no tax to recover and no symlinks to defend, purely to keep a table uniform |
| DC-8 | `chmod`'s guard (today `read` mode, which realpaths the leaf) | (a) W1 + an explicit leaf `lstat` that refuses a symlink; (b) W1 only, accepting that POSIX `chmod` follows the leaf; (c) leave it lexical like the reads | **[ADR-630](../adr/630-chmod-refuses-symlink-leaf.md)** · adopted as recommended — **(a)** | `chmod` both mutates state *and* dereferences the leaf, and the no-follow chmod variant exists only on macOS — so W1 alone would let a symlink leaf re-mode a file outside the tree. Refusing a symlink leaf costs nothing in faithfulness: git chmods only regular files (a `120000` entry carries no exec bit). (c) is how §4.1 would silently leave it if nobody noticed — the memory-hinted write-path-symmetry trap |
| DC-9 | `rename` src arm (today `read` mode, which realpaths the leaf) | (a) no-follow write guard — renames the link, not the target; (b) keep the realpath-follow; (c) fix in a follow-up | **[ADR-631](../adr/631-rename-acts-on-the-link-not-the-target.md)** · adopted as recommended — **(a)** | Verified with Node: renaming the realpath moves the target and leaves the link dangling, so `mv <symlink>` is broken today. (b) preserves a bug. (c) means shipping a rewrite of this exact line while knowingly leaving it wrong |
| DC-10 | ADR-051's absolute-symlink-target refusal (git writes such links verbatim — §1.2 pin M) | (a) keep it — it becomes the primary gate against leaking bytes from outside the repository once reads are unguarded; (b) relax to git parity; (c) relax it and add a read-time leaf check instead | **[ADR-632](../adr/632-symlink-targets-written-verbatim.md)** · **ratified (user judgment) — DEVIATES from the recommendation: (b)** | The design recommended **(a)**, keeping the gate as the primary creation-time defence. The user ratified **(b)**, git parity: a symlink target is opaque bytes, absolute or relative, written verbatim and never validated against the root set (§1.2 pin M). The recommendation's own escape clause is what settles it — the gate was already partial (relative escaping targets were exempt), so it never held the line it was credited with; **R5 did, and now does so explicitly and alone** (§7.1). What the deviation buys: tsgit can clone every repository git can clone, and the last symlink-shaped clone divergence goes. What it costs, accepted and recorded: a hostile repo can plant a link to any absolute path, and only a caller violating R5 could dereference it. (c) remains rejected — it is DC-1(b) by another name, with the same per-read cost |
| DC-11 | `walkWorkingTree`'s per-entry `lstat` (P9) | (a) out of scope; (b) reuse the `readdir` `DirEntry` kind bits and make the `FileStat` lazily fetched per consumer; (c) add a stat-free walk shape for path-only consumers | **[ADR-633](../adr/633-walk-working-tree-lazy-stat.md)** · adopted as recommended — **(b)** | `status`'s untracked pass takes only `{ path }` and pays a full `lstat` + `joinPath` per entry for nothing; the kind bits it re-derives were already in the parent's `readdir` batch. (c) duplicates the walker. (a) leaves a measurable `status` cost on the table in the one PR whose acceptance signal is `status:clean` — but it is genuinely a separate concern from containment, so this is the user's call, not the designer's |
| DC-12 | `status`'s double `lstat` per tracked path (P10) | (a) out of scope — its own design; (b) in scope, via a stat map shared between the tracked and untracked passes; (c) in scope, via a short-lived stat cache inside the adapter | **[ADR-634](../adr/634-status-shared-stat-map.md)** · **ratified (user judgment) — DEVIATES from the recommendation: (b)** | The design recommended **(a)**, deferral, and deliberately left (b) undesigned. The user ratified **(b)** into scope, so §10a designs it: one per-invocation map keyed by repo-relative path, shared by the tracked pass and the untracked walk, whichever stats first recording and the other consuming. The recommendation's stated blocker — "its own correctness surface (TOCTOU between passes, staleness)" — is answered rather than waved away in §10a's staleness statement: the two passes already race the working tree, and consuming one sample twice **removes** the second sample rather than adding a race class. Lifetime is one `status` call, which is why (c) stays rejected: an adapter-level cache would need an invalidation story on the hottest surface in the library, and this needs none |
| DC-13 | ADR shape for this change | (a) one ADR that supersedes `security.md`'s containment invariant and refines ADR-042/051/485/541; (b) one ADR per pillar (three); (c) supersede ADR-541 outright | **[ADR-625](../adr/625-git-parity-containment-posture.md)** · adopted as recommended — **(a)** | The three pillars are one posture change and share one rationale; splitting them invites a partial adoption that is less safe than either end state. (c) is wrong: ADR-541's root *set* decision survives and matters more for the write path |

## Test strategy

### Construction-time validation (pillar 1)

- `test/unit/domain/path/verify-path.test.ts` — the §1.1 matrix as `it.each`, one row per pinned name,
  asserting the exact `VerifyPathRejection` (never a bare "throws"): every `.git` family
  (`.git`/`.GIT`/`.Git`/`.git.`/`.git `/`.git...`), NTFS (`git~1`/`GIT~1`/`gIt~1`/`git~1 `/`git~1.`
  reject; `git~2`/`git~10`/`gi~1`/`.git~1` **accept**), stream forms (`.git:x`,
  `.git::$INDEX_ALLOCATION`), backslash-as-separator (`.git\config`, `a\.git\b` reject; `a\b`
  accept), HFS codepoints (the eight rejecting, **U+2060 accepting**), traversal/absolute/empty, the
  mode arm (`.gitmodules` at `100644`/`160000` accept, `120000` reject), and the accepts that guard
  over-rejection (`nul`, `con`, `aux.txt`, `x `, `dir./x`, `. git`, `.gi t`, `a<TAB>b`, `.gitmodules`,
  `dotgit`, `.gitattributes`/`.gitignore` at `120000`).
- **Property lenses (CLAUDE.md).** Lens 3 (*total function over an algebraic grammar*) **fits**:
  `verifyPath` must never throw for any input in a declared safe subset and must return a
  `VerifyPathRejection | undefined` — `test/unit/domain/path/verify-path.properties.test.ts`, arbitrary
  path strings over ASCII plus the ignorable codepoints, `numRuns` 100. Lens 2 (*compositional matcher*) **fits
  partially** for `isDotGitAlias`: appending a non-alias component never flips a verdict to reject;
  prefixing/suffixing an accepted component with a non-ignorable codepoint keeps it accepted. Lens 1
  (round-trip) and lens 4 (idempotence/counting) **do not fit** — there is no serialiser and no 1:1
  syntactic↔semantic feature to count. Generators go in a shared `arbitraries.ts` beside the example
  file; no seed committed.
- Existing suites **extend, not replace**: `test/unit/domain/git-index/path-validator.test.ts` (11
  cases) gains the alias rows; `test/unit/domain/working-tree-path.test.ts` (~26 cases) keeps every
  current expectation and gains NTFS/HFS rows; `synthesize-tree-from-index.test.ts:279`'s
  defence-in-depth case stays green.

### Adapter behaviour (pillars 2 and 3)

**Classification rule** (apply it per case; do not classify by method name): a case **flips** only if its
refusal was produced by the **post-realpath** stage — the input is inside a root prefix and the
*resolution* (symlink or 8.3 expansion) escapes. A case **stays** if the input is *lexically* outside
(`../…`, an absolute foreign path, the prefix-only sibling `root-evil`), because the lexical gate is
retained on every surface (§6). One **second** flip class exists, and only one: cases pinning
ADR-051's symlink-**target** refusal, which ADR-632 removes outright. They are write-side, so the
rule above would misfile them as "stays" — classify them by the ADR, not by the rule.

| Bucket | Where | Action |
|---|---|---|
| **Flips** (post-realpath read refusal → allowed) | `node-file-system.test.ts` L71 (read through an in-root symlink pointing outside), L123 (`lstat` of a child under an in-root directory symlink pointing outside), L1326 (multi-root: symlink in root A targeting outside every root); `node-file-system-injected.test.ts` L1248 (in-root path whose realpath resolves outside), L2015 (×2 policies — exact-root leaf whose realpath escapes), plus whichever of L1001 / L1894 (×2) are realpath-staged rather than lexically outside | rewrite to the **new** observable: content returned / `FILE_NOT_FOUND`. Keep each file's lexical sibling case as the proof the gate still exists |
| **Stays — lexical escapes** (the large majority) | the shared contract's **whole** `security matrix` — 21 methods × 2 escapes × 2 adapters = **84 cases** — because both inputs (`'../outside-root'` and `<rootDir>-evil/file.txt`) are lexical; `node-file-system.test.ts` L349 (rename via absolute path), L1280 (outside every root, under the common ancestor), L1303 (multi-root write), L1372 (`exists` outside every root); `injected` L100/L126/L152 (`..` escapes — these now exercise the `..` prefilter arm), L1068, L1166, L1309 (pre-check fires before any I/O), L3130/L3156 (prefix-only sibling); `test/integration/node-shim.test.ts:305` (the outside secret file is a *sibling directory* — lexically outside, still `PERMISSION_DENIED`) | keep verbatim. These are the regression wall for the lexical gate |
| **Stays — write side** | `node-file-system.test.ts` L97 (write onto a symlink leaf); `injected` L1958 (×2, creation post-check), L666/L2916 (Windows symlink refusal — a platform capability check, nothing to do with targets), L2276 (relative target passed through unchanged); `interpretCreationLstat`'s four cases; `posix-only/node-fs-real-symlinks.test.ts` cases 1 and 3; `win-only/node-fs-windows-real.test.ts` case 2 | keep the expectation; re-point at W1/W2. Where `O_NOFOLLOW` replaces the pre-write `lstat`, the injected test asserts the **flag** passed to `open`/`writeFile`, not an absent `lstat`. L2276 keeps its assertion verbatim but loses its framing: passing a relative target through is no longer an *exemption*, it is the rule for every target — so its comment about a later read re-checking containment is struck (no such re-check exists after §4.1) |
| **Flips — ADR-632 symlink targets** | `node-file-system.test.ts` L1429 (absolute target outside every root → `PERMISSION_DENIED`, no link created); `injected` L2214 (`/etc/passwd` → refused, `fsOps.symlink` not invoked) and L2246 (absolute target with embedded `..` resolving outside → refused) | rewrite to the new observable: the link **is** created and `fsOps.symlink` is invoked with the target string **unchanged**; on the real-FS case, `readlink` returns the absolute target byte-for-byte and the target file is untouched. Their "absolute-symlink-info-oracle" rationale comments go with the gate — leaving them would document a defence that no longer exists. The `realpathNearestExisting` call they pinned disappears from `symlink`; its 5 own cases stay (W1 still uses it) |
| **Unaffected** | `mapErrno` (all arms incl. `ELOOP`/`EISDIR`→`PERMISSION_DENIED`), `runFs`, `mapStat`, `mapConcurrent`, `isErrnoException`, `isWindowsSymlinkRefusal`, `realpathNearestExisting` (5 cases), `pathContains`/`pathContainsNormalized` + the 4 fast-check properties, `path-policy.test.ts` (its `normalizeForCompare` `it.each` gains a `/`→`\` row, §4.1), `node-fs-locked-directory.test.ts`, `fsck-pack-accessibility-interop.test.ts`'s six EACCES assertions, the whole `wrap-fs-validator.test.ts` (~45 `PATHSPEC_OUTSIDE_REPO` cases), `repository.test.ts` L662/L1111/L1221 and its config-scope arms (Memory adapter), `file-system-layout-probe.test.ts:46` (Memory adapter) | must stay green untouched |
| **Retired** | `injected` L1659/L1711/L1838 per-parent **verdict** cases (the verdict cache narrows to the write path), L1430–L1535 lstat-mode parent-realpath LRU cases, L1765/L1802 (verdict recomputed after `rename`/`rmRecursive` — re-point at the write path), L1361/L1388/L2069 exact-root recognition (the `isExactRoot` arm disappears), L3007/L3048 read-side prefix precompute | delete with the code they pin, or re-point at the write path. The two `Stryker disable` proofs on `checkContainment`'s catch arms are re-derived against the new structure, never carried forward (R10) |
| **Memory adapter** | `memory-file-system.test.ts` (51 cases incl. the 40-hop cap, the recursive-symlink `UNSUPPORTED_OPERATION`, construction-time containment) and its inherited contract matrix | unchanged (R7) |

New adapter coverage: `read`/`stat`/`readdir`/`lstat` through a symlink resolving outside every root
now **succeed**; a lexical escape (`../outside`, sibling `root-evil`) still refuses on **every** method
(read and write); `chmod`, `rename` src, `rm`, `rmRecursive` and `openWithNoFollow(_, 'write')` each
refuse a write escape through a symlinked parent (one isolated test per surface — a guard-clause
family needs one test per condition, never one test that trips several); `rename` of a symlink moves
the **link** and leaves the target in place; `symlink` accepts **any** target string — absolute
outside every root, relative with escaping `..`, and a dangling one — writing it verbatim and never
touching whatever it points at (ADR-632, R13).

### Interop (faithfulness — the only tier that proves it)

`test/integration/git-parity-containment-interop.test.ts`, built on `interop-helpers.ts` (`runGit`
with `GIT_*` scrubbed, isolated non-existent `HOME`, `GIT_CONFIG_NOSYSTEM=1`), one shared
`beforeAll` repo per scenario group and a 60 s timeout (the known interop load→validate flake):

1. Hostile tree names — for each of `..`, `.git`, `git~1`, `.gi<ZWNJ>t`: build the raw tree with
   `hash-object -t tree --literally`, then assert **git** refuses at `read-tree`/clone with
   `invalid path` and checks nothing out, and **tsgit** refuses at the same stage with
   `INVALID_INDEX_ENTRY` and writes nothing. Compare the on-disk state (empty worktree, `.git` only),
   not the message bytes (ADR-249).
2. `.gitmodules` at mode `120000` — both refuse; at `100644`/`160000` both accept.
3. Symlinked leading directory — `status` reports the symlink as untracked and the tracked child as
   deleted in **both**; `add <child>` refuses in both; `add -A` stages the symlink as `120000` in both
   and leaves the outside file untouched.
4. Leaf symlink — `add` stores the target path as blob content in both; checkout of a regular file
   over it replaces the link and leaves the outside target byte-identical in both.
5. Write/delete through a symlinked leading directory — assert the outside file is byte-identical
   after each operation in both tools, and record tsgit's shape (refuse vs unlink-and-create) against
   git's per DC-5/DC-6.
6. Object store outside the repo — `.git/objects` symlinked out: both read the object. `.git`
   symlinked out: both report the same `status`. (Alternates stay a read-not-refused assertion until
   tsgit implements them.)
7. Root reached through a symlink — tsgit's resolved `workDir` matches `git rev-parse
   --show-toplevel` (the realpath), pinning ADR-042's retention.
8. **Symlink targets written verbatim (ADR-632, R13)** — a source repo carrying three `120000`
   entries: `abs -> <tmp>/outside/secret` (absolute, escaping, and **hermetic** — the byte/mtime
   assertions run against a file the test owns), `rel -> ../../../etc/passwd` (relative, escaping) and
   `sys -> /etc/passwd` (the literal pin-M shape, asserted for link bytes only, never read or
   written). Clone with **git** and with **tsgit** into two destinations, then assert: every entry is
   a symlink in both; `readlink` returns the same bytes in both and equals the blob content; and the
   owned outside file's bytes and mtime are unchanged after both clones. The negative half matters as
   much as the positive: tsgit must **not** raise `PERMISSION_DENIED` on any of the three, which is
   the assertion that would have failed before ADR-632. A checkout of the same commit into an existing
   worktree repeats both halves.

### Working-tree stat map (§10a, ADR-634)

- `test/unit/application/commands/internal/working-tree-stat-map.test.ts` — the collection itself:
  `sampled` on an unrecorded path returns `undefined`; a recorded sample is returned; two instances
  share nothing. Small, but it is the unit the two consumers are mocked against.
- `status`'s call-count pins (R12), against an injected filesystem that counts `lstat` per path — the
  only oracle that proves a deduplication, since a wall-clock bench cannot:
  - a repo with N tracked, unmodified files plus M untracked ones ⇒ exactly N + M `lstat` calls, and
    **no path appears twice**;
  - the map is populated by the tracked pass and consumed by the walk: arrange a walk consumer that
    *does* read the lazy stat, assert the tracked path costs one `lstat` total while an untracked-only
    path costs one of its own (this is the case ADR-633 alone does not cover);
  - a tracked path absent from disk records nothing — the `lstat` rejects, `status` reports `absent`,
    and a later walk over a path recreated in between takes a fresh sample rather than a stale
    negative. Two isolated tests, one per condition, never one that trips both.
- Unchanged and asserted so: the stat-cache fast path (`is-entry-stat-clean.test.ts`) keeps every
  current expectation — the map changes *where the sample comes from*, never what `ie_match_stat`
  does with it; and `compareWorkingTreeDelta` / `walkWorkingTree` called **without** a map issue
  exactly the calls they issue today (one test each, guarding the optional arm's absent branch —
  the arm mutation testing will otherwise flip silently).
- Property lenses: none fit. This is per-invocation orchestration with no grammar, no round-trip and
  no algebraic composition — CLAUDE.md's "no virtue points" case, recorded so the omission reads as a
  decision rather than an oversight.

### Gates

`npm run validate` before every commit; `test:coverage` at 100% on all touched files;
`test:mutation` scoped to `src/adapters/node/node-file-system.ts`, `src/adapters/node/path-policy.ts`,
`src/domain/path/verify-path.ts`, `src/domain/working-tree-path.ts`,
`src/domain/git-index/path-validator.ts` and — for the two ratified performance slices —
`src/application/commands/status.ts`, `src/application/primitives/walk-working-tree.ts`,
`src/application/primitives/compare-working-tree-entry.ts` plus the new
`working-tree-stat-map.ts`, per the repo's Stryker procedure. `reports/api.json` is regenerated and
committed: §10a adds an optional parameter to two public exports and ADR-633 changes
`WalkWorkingTreeEntry`'s stat shape, and the pre-push gate refuses a stale report. The four
benchmark scenarios are read off the CI nightly, never a local run.

## Out of scope

- **A `containment` policy/config knob** keeping the strict mode available — explicitly rejected by the
  user. No knob, no environment variable, no `OpenNodeRepositoryOptions` field.
- **Memory and Browser/OPFS containment** — no tax to recover, nothing to escape to (§8).
- **The facade validator** (`wrapFsValidator`) — its lexical layer and `PATHSPEC_OUTSIDE_REPO`
  vocabulary are unchanged; its ~45 tests must stay green as-is.
- **Loose-before-pack reordering** — rejected twice against an empirical pin (P8).
- **Implementing `objects/info/alternates`** — this change removes the containment blocker; reading
  the file is its own feature.
- **Relaxing write refusals git does not have** — the symlink-leaf refusal on `appendUtf8` (a
  symlinked `.git/logs/HEAD` would be followed by git) is a pre-existing, stricter-than-git write
  behaviour and stays. The brief's mandate is to *preserve* write refusals; relaxing this one is a
  separate faithfulness item. ADR-051's absolute-target refusal is **no longer in this bucket** — the
  user ratified relaxing it here (ADR-632, §4.2, R13), which is the single write relaxation this
  change carries.
- **`parentRealpathCache` → `openat`-relative I/O** to close the parent-swap TOCTOU (§7.4) — Node
  exposes no handle-relative filesystem API; the window is recorded, unchanged, and not widened.
- **tsgit's stricter-than-git tree parser** (`parseTreeContent` rejects `..` where `git cat-file`
  prints it) — pre-existing; DC-3 keeps the *new* validation off that boundary rather than fixing the
  old one.
- **Windows-only empirical pinning** — `core.protectNTFS`'s defaults and alias set were pinned on
  darwin (they are platform-independent, §1.1); the Windows-only `O_NOFOLLOW`-ignored branch and 8.3
  reconciliation remain covered by the injected `windowsPolicy` tests and the `win-only` integration
  tier, not by a real Windows probe run.
- **Rendered output** — no command gains or loses a display string (ADR-249).
