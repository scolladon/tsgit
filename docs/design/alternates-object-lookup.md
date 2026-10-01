# Design — alternates object lookup (`objects/info/alternates`)

> Brief: read objects through `objects/info/alternates` the way canonical git 2.55.0 does —
> every read, existence probe, abbreviation and enumeration falls through the alternate chain
> (loose, packs, midx); the alternates file is parsed exactly as `parse_alternates` parses it;
> writes stay local but count alternate objects as present; `fsck`/`gc`/`prune` treat alternate
> objects as present-but-not-local; all I/O through the `FileSystem` port; zero per-object cost
> for repositories without an alternates file. Issue #302 (sfdx-git-delta discussion #1457:
> `ParameterIsNotGitSHA` on a Bamboo cached checkout).
>
> Status: draft → self-reviewed ×3 → **awaiting decisions** (12 candidates, §Decision candidates).
>
> **Three premises of the brief do not survive the pins, and each is load-bearing.**
>
> 1. *"A missing-object re-scan that refreshes the primary refreshes the alternates too"* — true
>    for the alternates' **packs**, false for the alternates **file**. git's miss retry
>    (`odb.c:do_oid_object_info_extended`, `OBJECT_INFO_SECOND_READ`) re-prepares every source's
>    pack store (`packfile.c:packfile_store_read_object_info` → `packfile_store_reprepare`) and
>    deliberately skips the loose second read (`odb/source-loose.c`, "the second read shouldn't
>    cause new loose objects to show up"). The alternates file is re-read only by
>    `odb_reprepare` (fsck start, fetch-pack, repack, …), and even then **only adds** sources.
> 2. *"`fsck` connectivity treats alternate objects…; verify whether `git fsck` also validates the
>    alternates' own objects"* — it does, fully. Pins F2–F4c: the borrower's `git fsck` reports the
>    donor's corrupt loose objects, corrupt **unreachable** donor packs, and every donor object
>    unreachable from the borrower's refs as `dangling`. Not connectivity-only — the whole donor
>    store is in the audit universe.
> 3. *"Writes stay in the primary … tsgit doesn't duplicate objects the alternate already holds"* —
>    git does not merely skip the write: it **freshens** the alternate's copy (`utime` on the
>    donor's loose file or `.pack`, pins W1/W2) and writes a local copy only when that freshen
>    fails (W3/W2b). tsgit has no mtime-setting port method today, and the write path has no
>    existence probe at all (it relies on `writeExclusive`'s `FILE_EXISTS`), so it already writes
>    a duplicate loose copy of any object the **primary** holds packed. DC-10.

## Context

### What exists today

Nothing in `src/` reads `objects/info/alternates`. Every object path is derived from
`commonGitDir(ctx)`:

| surface | file | how it is rooted today |
|---|---|---|
| pack registry (packs, `.idx`, `.rev`, midx gate, bitmaps) | `src/application/primitives/pack-registry.ts` (`createPackRegistry`, `listPackDir`, `createStoreGate`, `scanPacks`) | `packsDir(commonGitDir(ctx))`, `ctx.fs` |
| midx load | `src/application/primitives/internal/midx-source.ts` (`loadMidxSet(ctx, packsDir, listing)`) | `packsDir` parameter + `ctx.fs` |
| registry memo | `src/application/primitives/read-object.ts` (`registryMemos`, `resolvedRegistries`, `getPackRegistry`, `peekPackRegistry`, `refreshPackRegistry`, `disposePackRegistry`) | one registry per `ctx.session` |
| loose membership cache | `src/application/primitives/internal/loose-oid-cache.ts` (`fanoutCache`, `probeLooseOid`, `invalidateLooseOid`, `forgetLooseOidPrefix`) | `objectsDir(commonGitDir(ctx), prefix)`, keyed by session |
| loose reads | `object-resolver.ts` (`readLooseCompressed`, `looseCompressedBytes`, `tryLoose`); `read-object.ts` (`loosePathFor`, `readLooseDeclaredSize`) | `looseObjectPath(commonGitDir(ctx), id)` |
| buffered read order | `object-resolver.ts` (`resolveObjectContentWithDepth` → `registry.assertLoadable()` → `tryResolveViaRegistry`: packs, then `resolveLooseArm`) | primary only |
| miss retry | `internal/retry-after-rescan.ts` (`retryOnceAfterRescan`) → `internal/pack-miss-rescan.ts` (`rescanOnFullMiss`: `registry.reprepare()` + `forgetLooseOidPrefix`) | primary only |
| existence | `has-object.ts` (`hasObject`, `probeOnce`), `commands/internal/fsck/object-presence.ts` (`objectIsPresent`) | primary only |
| streamed blob | `internal/blob-source.ts` (`openBlobSource`, `verifyStoredObject`) | primary only |
| enumeration | `enumerate-objects.ts` (`enumerateObjects`, `collectLooseObjectIds`, `collectPackedObjectIds`) | primary only |
| abbreviation | `resolve-oid-prefix.ts` (`resolveOidPrefix`, `scanLoose`, `scanPacks`) → `ambiguousOidPrefix` (`src/domain/commands/error.ts:879`) | primary only |
| write | `write-object.ts` (`writeObject`: serialize → deflate → `writeExclusive`; `FILE_EXISTS` ⇒ already present) | no pre-write existence probe |
| gc / prune | `commands/internal/gc-pipeline.ts` (`owned` from `enumerateObjects(ctx,{includePacks:false})` + `registry.all()`; `toNormalPackInputs`; `packedAnywhere`; `pruneLooseFiles`) | primary only |
| fsck | `commands/fsck.ts` (universe = `enumerateObjects`), `internal/fsck/{object-cache,content-validation,pack-health,rev-index-health,midx-health,bitmap-health,object-presence}.ts` | primary only |

### Containment today (ADR-625, ADR-721, ADR-298)

ADR-625 made **reads lexical-only** against the layout root set (`workDir`, `gitDir`, `commonDir`)
— zero syscalls, but *"a lexically-outside path still throws `PERMISSION_DENIED` on every
surface"*. The containment design's R6/pin D ("alternates to a donor outside → read-not-refused")
removed the *realpath* gate, not the lexical one; no test ever exercised it (`grep -rn alternates
test/` → zero hits). So a donor at `/opt/cache/repo.git/objects` is today refused by:

- **Node** — `NodeFileSystem` lexical check against `rootDirs` (`src/adapters/node/node-file-system.ts`).
- **Memory** — `MemoryFileSystem.resolve` (`memory-file-system.ts:505`) → `permissionDenied`.
- **Browser/OPFS** — `splitPath` maps every absolute path into the OPFS root and refuses only
  `..`; an absolute alternate path is *readable* if that OPFS sub-tree exists.

The one existing escape hatch is ADR-298's `ctx.worktreeFs(paths)`: the facade asks the runtime
hook `fallback.makeWorktreeFs(roots)` (Node only, `src/index.node.ts:175`) for an adapter rooted
at `roots`, wraps it with `wrapFsValidator` for writes, memoises by root set; memory/browser
omit the hook and fall back to the repo-rooted fs.

### Constraining prior decisions

| ADR / doc | constraint |
|---|---|
| ADR-226 | byte-faithful data + on-disk state; divergence only by ADR |
| ADR-249 | structured data only — no rendered stderr; warnings must be data |
| ADR-412 | fsck scope bullet *"alternate object stores (tsgit has no alternates)"* — must be amended (DC-7) |
| ADR-509 | loose-first precedence + loose oid cache (streamed blob / `hasObject` arms) |
| ADR-584 | a pack finding carries the pack **base name** — ambiguous across sources (DC-8) |
| ADR-592/593 | midx authoritative for its packs; Tier-A die / Tier-B discard — per source (Pin M) |
| ADR-597 | usable midx defers `.idx` loading — per source |
| ADR-601 | fsck reports midx findings — git runs `multi-pack-index verify --object-dir <source>` **per source** (`builtin/fsck.c` L1173) |
| ADR-625 / ADR-721 / ADR-298 | read containment lexical, single authority in first-party adapters; widened fs via runtime hook |
| `docs/design/midx-read-support.md` L6 / item 7 | midx-in-an-alternate to be re-decided once alternates land (DC-9) |
| `docs/design/fsck.md` L238, L500, L666 | `full` documented as "alternates out of scope" — amended with DC-6/DC-7 |

### House patterns this must follow

- Per-session memo keyed on `ctx.session` (`WeakMap<Session, …>`), `PromiseMemo` for async
  construction, a synchronous `peek*` fast path gated on `repoSettingsVerdictSettled`.
- Adapter errors classified structurally on `data.code` via `errorDataCode`
  (`src/domain/error-data-code.ts`) — never `instanceof` across bundles.
- Diagnostics today: `ctx.logger?.warn?.('packRegistry: …', {…})` (`listPackDir`, `createStoreGate`).
- Domain parsers are pure, live under `src/domain/`, and get a `*.properties.test.ts` sibling.
- `deriveContext` is the only way to derive a Context; a submodule derivation mints a fresh session.

## Requirements

- **R1** Every object read (buffered, streamed blob, metadata/declared size), existence probe
  (`hasObject` quick/recheck, fsck `objectIsPresent`), abbreviation (`resolveOidPrefix`) and
  enumeration (`enumerateObjects`) consults the source chain **primary, then each alternate in git's
  depth-first pre-order** (Pin O1). Within one source each arm keeps its current order
  (buffered reads: packs, midx-gated, then loose — git's `odb_source_files_read_object_info`;
  streamed blob: loose first, ADR-509). A source is never consulted before every earlier source
  has missed (Pin M2/M3).
- **R2** `parseAlternatesFile` reproduces `odb.c:parse_alternates` + `quote.c:unquote_c_style`
  byte-for-byte on every row of Pin matrix P (comments, blanks, quoting, NUL, CR, trailing
  space, quote spanning lines, broken quote fallback, trailing text after a closing quote).
- **R3** Chain resolution reproduces `odb_add_alternate_recursively` + `odb_is_source_usable`:
  relative to the realpath of the **holding** objects dir; realpath-normalised; trailing slashes
  trimmed; self and duplicates skipped silently (by realpath); depth-first; a source at depth 5
  with ≥1 normalised entry stops with *nesting too deep*; cycle-safe.
- **R4** An unusable alternate never fails a read: it is skipped and reported as a structured
  diagnostic (shape per DC-1), classified like git's three messages (Pin U).
- **R5** A full miss re-prepares **every** source's pack registry and forgets the missed id's loose
  prefix in **every** source; the alternates file itself is re-read only on `refresh()`
  (git's `odb_reprepare`), add-only (DC-12).
- **R6** Writes land only in the primary. The pre-write probe counts every source (DC-10).
- **R7** `gc` packs, crufts and prunes **local** objects only; its reachability walk reads through
  alternates; its "already packed" sweep (`packedAnywhere`) counts alternate packs (Pins G1–G5).
- **R8** `fsck` audits every source as git does (Pins F1–F5, M1); ADR-412 amended (DC-6/DC-7).
- **R9** All alternate I/O goes through the `FileSystem` port; no `node:` import outside
  `src/adapters/`; behaviour on memory/browser defined (DC-3).
- **R10** A repository without `objects/info/alternates` pays one extra `read` per session
  (FILE_NOT_FOUND), issued concurrently with the primary registry construction, and nothing per
  object **read** beyond iterating a one-element source array; the write probe (DC-10) is a
  separate, deliberate per-write cost; `bench:ab` shows no regression (§Perf).
- **R11** 100 % coverage, zero surviving non-equivalent mutants, interop pins for every row below.

## Design

### Pinned matrices — git 2.55.0, this host (darwin 25.6.0)

Every row was run with `PATH=$HOME/.local/git-2.55.0/bin:/usr/bin:/bin`, `env -i`, isolated
`HOME`, `GIT_CONFIG_NOSYSTEM=1`, `commit.gpgsign=false`, in a `mktemp -d` throwaway. `$T` is the
throwaway's realpath. Scripts: session scratchpad `alt-probe-{1..5}.sh` (re-creatable from the
rows; the interop suite reproduces each row).

#### Pin A — what clone writes, and plain reads on a borrower

| # | setup | observation |
|---|---|---|
| A1 | `git clone --shared donor s` | `s/.git/objects/info/alternates` = `$T/donor/.git/objects\n` (absolute, realpath'd base); `s/.git/objects` holds **no** object file |
| A2 | `git clone --reference donor file://$T/donor r` | identical file bytes; zero local objects |
| A3 | `git clone --shared ./d rel` | `$T/./d/.git/objects\n` — absolute but **un-normalised** `./` (parser must normalise) |
| A4 | on `s`: `cat-file -t HEAD` / `cat-file -p HEAD:f` / `log --format=%s` / `diff --stat HEAD~1 HEAD` / `status --porcelain=v2 --branch` | `commit` / `d2` / `c2,c1` / `1 file changed, 1 insertion(+), 1 deletion(-)` / clean, `branch.ab +0 -0`; all exit 0 |
| A5 | on `s`: `cat-file --batch-all-objects --batch-check` | lists all 6 donor objects — enumeration includes alternates |

#### Pin P — the file grammar (`parse_alternates`, `unquote_c_style`)

| # | file bytes (after `$T`) | git |
|---|---|---|
| P1 | `# c\n\n   \n  # indented\n<abs>\n` | `#` is a comment **only at column 0**; blank line skipped; `"   "` and `"  # indented"` are **paths** (relative) → `object directory $T/fmt.git/objects/    does not exist` and `…/objects/  # indented does not exist`; `<abs>` used |
| P2 | `<abs>\r\n` | `\r` kept → `object directory <abs>\r does not exist`; read fails |
| P3 | `<abs> \n` (trailing space) | kept → `does not exist`; read fails |
| P4 | `<abs>` (no final `\n`) | used |
| P5 | empty file | no alternates, no message |
| P6 | `"<T>/nl\nx/q.git/objects"\n` | C-unquoted (`\n` escape) → used |
| P7 | `"<T>/sp\040ace/q.git/objects"\n` | octal escape → used |
| P8 | `"<T>/\303\251/u.git/objects"\n` | octal UTF-8 bytes → `é` → used |
| P9 | `"<T>/x⏎y/q.git/objects"\n` (raw newline **inside** the quotes) | one path — the quoted span crosses the line break → used |
| P10 | `"<abs>` (no closing quote) | broken quoting → whole line taken **unquoted** → relative → `unable to normalize alternate object path: $T/fmt.git/objects/"<abs>` |
| P11 | `"<T>/a.git/x\q/objects"` (bad escape) | unquote fails → unquoted fallback → `unable to normalize … $T/p.git/objects/"<T>/a.git/x\q/objects"` |
| P12 | `"<abs>" trailing\n` | quoted path used, then the **one** separator-skip consumes the space and `trailing` becomes a second (relative) entry → `object directory $T/fmt.git/objects/trailing does not exist` |
| P13 | `<a>\n\0<b>\n` | parsing stops at the NUL — only `<a>` (count-objects lists one alternate) |
| P14 | `"../../a.git/objects"\n` | quoted relative path → resolved against the holding dir → used |

#### Pin R — path resolution

| # | setup | git |
|---|---|---|
| R1 | `rel.git/objects/info/alternates` = `../../middle.git/objects`; `middle`'s = `../../sub/leaf.git/objects` | both blobs readable from `rel.git` — a nested relative entry resolves against **middle's** objects dir (the holding dir), not the primary's |
| R2 | `<T>//middle.git/./objects///` | normalised → used |
| R3 | `<T>/nope/nope2/objects` (intermediate missing) | `error: unable to normalize alternate object path: $T/nope/nope2/objects` |
| R4 | `<T>/middle.git/missing-objects` (last component missing) | `error: object directory $T/middle.git/missing-objects does not exist; check .git/objects/info/alternates` |
| R5 | entry names a regular file | same `does not exist` message |
| R6 | entry through a symlink (`middle-alias → middle.git`) | used; stored as the **realpath** (`count-objects -v` prints `$T/W.git/objects` for a `W-alias.git` entry, O1) |
| R7 | relative entry with a wrong depth in a non-bare repo (`nb/.git/objects/../../dd/…`) | `unable to normalize … $T/nb/.git/objects/../../dd/.git/objects` — the message carries the **joined, un-normalised** path; base is the realpath of the holding dir |
| R8 | entry is a repository root (`$T/dd`), not an objects dir | no message; objects simply not found (`<dd>/xx/…` does not exist) |

#### Pin N — nesting depth

| # | setup | git |
|---|---|---|
| N1 | chain `n0 → n1 → … → n8`, one unique blob each | from `n0`: blobs of `n0`…`n6` found, `n7`/`n8` **not**; every command prints `error: $T/n6.git/objects: ignoring alternate object stores, nesting too deep` (the **depth-5** source whose own entries are ignored) — even when the looked-up object is local |
| N2 | from `n1` | sees through `n7`; message names `n7` — depth is relative to the opening repo |
| N3 | depth-5 source's file holds only comments/blanks | **no** message (`sources.nr == 0`) |
| N4 | depth-5 source's file holds one unresolvable entry | `unable to normalize …` printed (the file **is** parsed), **no** nesting message (the failed entry is never pushed, `sources.nr == 0`) |

Rule (`odb.c:odb_add_alternate_recursively`): primary's entries are depth 0; a source at depth *d*
reads its own file; if it yields ≥1 normalised entry and `d + 1 > 5`, report and ignore them all.
Six alternate levels are reachable.

#### Pin D — duplicates, self, cycles, order

| # | setup | git |
|---|---|---|
| D1 | `cy1 ⇄ cy2`, each listing the other **and itself** | both read each other's objects; no message, no loop |
| D2 | `.` + duplicate line + same path with trailing `/` | silently skipped |
| D3 | self through a symlinked spelling of the primary | silently skipped (realpath equality, `ignore_case`-aware) |
| D4 | same donor listed as `dd` and `dd-alias` (symlink) | deduped by realpath |
| O1 | `P → [X, Y, X/]`, `X → [Z]`, `Y → [W]`, `Z → [X, W-alias]` | `count-objects -v` order: `X, Z, W, Y` — **depth-first pre-order**, dedupe by realpath (`W-alias` collapses into `W`, which is then not re-added under `Y`) |

#### Pin U — unusable alternates (the three git diagnostics)

| # | condition | git (stderr, continues) | read outcome |
|---|---|---|---|
| U1 | realpath of the joined path fails (missing intermediate component, `ENOTDIR`, …) | `error: unable to normalize alternate object path: <joined path>` | alternate skipped |
| U2 | normalised path is not a directory (missing leaf, regular file) | `error: object directory <path> does not exist; check .git/objects/info/alternates` | skipped |
| U3 | `info/alternates` unreadable (`EACCES`, `EISDIR`; `ENOENT`/`ENOTDIR` are silent) | `warning: unable to access '<file>': Permission denied` / `…: Is a directory` | that source's alternates ignored |
| U4 | alternate objects dir `chmod 000` (stat succeeds) | U3 for its own `info/alternates`, then `unable to open object pack directory: …: Permission denied` and `unable to open loose object <oid>: Permission denied` at read time | object not found (`fatal: Not a valid object name`, 128) |
| U5 | fanout dir `chmod 000` in the alternate | `error: unable to open loose object <oid>: Permission denied` | not found |
| U6 | missing donor on `log` / `status` / `count-objects` | one `unable to normalize …` line per process, then normal output, exit 0 | — |

#### Pin W — the write path (`write_object_file` → `odb_freshen_object`)

| # | setup | git |
|---|---|---|
| W1 | donor holds X **loose** (mtime 2001); borrower `hash-object -w` X | **no** local file; donor's loose file mtime → now (freshened) |
| W2 | donor holds X **packed** (`.pack/.idx/.rev` mtime 2001) | no local file; donor's **`.pack`** mtime → now; `.idx`/`.rev` untouched |
| W2b | same, donor `.pack` immutable (made immutable with a BSD file flag) | freshen fails → local loose copy written |
| W3 | donor loose X immutable | freshen fails → local loose copy written; donor mtime unchanged |
| W4 | borrower `commit` whose tree is the donor's tree | only the new commit is written locally |
| FE1 | borrower (alternate = clone of `up`) `fetch file://up main` | ref created, **zero** objects transferred/written |

#### Pin G — gc / repack / prune

| # | setup | git |
|---|---|---|
| G1 | borrower with 3 local loose objects atop donor history; `git gc` | borrower pack holds exactly the 3 local oids; `count-objects -v` prints `alternate: $T/donor6/.git/objects` |
| G2 | `repack -a -d -l` vs `repack -a -d` | 3 vs 9 objects — gc passes `-l` (`builtin/gc.c:897,1595`); `-l` excludes both loose and packed borrowed objects (`pack-objects.c` `local`) |
| G3 | donor holds an unreachable loose object (mtime 2001); borrower `prune --expire=now`, then `gc --prune=now` | donor object still present after both — prune iterates the **primary** only (`builtin/prune.c:201`) |
| G4 | borrower holds a loose copy of a donor-**packed** object; `prune-packed` | borrower's loose copy removed — "packed" counts alternate packs |
| G5 | same; `git gc` | borrower's loose copy removed, no local pack created |

#### Pin F — fsck (the brief's open question)

| # | setup | `git -C borrower fsck` |
|---|---|---|
| F1 | clean `--shared` borrower, zero local objects | silent, exit 0 — alternate objects satisfy connectivity |
| F2 | donor gains an unreachable blob | `dangling blob 4ba8ea…`, exit 0; same with `--connectivity-only`; same line in the donor's own fsck |
| F2b | donor commit on a branch the borrower lacks | borrower reports it `dangling commit fd050d…`; `--unreachable` lists its blob+tree too |
| F3 | donor holds a loose file whose content hashes to a different oid | `error: 12799c…: hash-path mismatch, found at: $T/donor3/.git/objects/e4/5c9c…`, exit **1**; identical with `--no-full`; `--connectivity-only` reports both as dangling, exit 0 |
| F3b | donor loose file with broken zlib | `error: inflate: data stream error (incorrect header check)` / `unable to unpack header of <donor path>` / `<oid>: object corrupt or missing: <donor path>`, exit 1 |
| F4 | donor pack: reachable object's bytes corrupt | `fatal: packed object e05f5b… (stored in $T/d4/.git/objects/pack/pack-….pack) is corrupt`, exit 128 — same as the donor's own fsck, path absolute |
| F4b | donor pack trailer corrupt | `packfile <abs donor pack> does not match index` ×N, `invalid sha1 pointer`, `missing blob …`, exit **14** — same bits as the donor's own fsck |
| F4c | a separate donor pack holding only an **unreachable** object, corrupted | `error: <abs donor pack> pack checksum mismatch` / `index CRC mismatch for object 0d3bb2…` / `cannot unpack …`, exit **4** — the borrower verifies alternate packs it never reads |
| F5 | donor directory removed | `unable to normalize …` ×4 (fsck's `odb_reprepare` re-prints), `invalid sha1 pointer` per ref, `invalid reflog entry`, `invalid sha1 pointer in cache-tree`, `missing blob …`, exit **10** |

**Answer: yes.** git 2.55 `fsck` validates the alternates' own objects — loose content (F3,
F3b; also under `--no-full`), every alternate pack including unreachable ones (F4c), and
classifies donor-only unreachable objects as dangling (F2, F2b). Source: `builtin/fsck.c`
L1072–1074 (`fsck_source` for every `odb->sources`) and `repo_for_each_pack` over all sources
for `verify_pack`; midx/commit-graph verify children per source (L1158–1189).

#### Pin M — midx in an alternate

| # | setup | git |
|---|---|---|
| M1 | donor `repack -ad` + `multi-pack-index write`; `clone --shared` | borrower reads donor objects through the donor's midx |
| M2 | donor midx signature smashed (`XXXX`); borrower reads a **local** loose object | exit 0 — the alternate's midx is never loaded |
| M3 | same; borrower reads a **donor** object | `fatal: multi-pack-index signature 0x58585858 does not match signature 0x4d494458`, 128 — ADR-593's Tier A fires **when the lookup reaches that source** |
| M4 | same; borrower `fsck` | same fatal, 128 |

M2/M3 are only consistent with git's **per-source** order (primary packs → primary loose →
alternate packs → …). A "all packs of all sources, then all loose" order would load the
alternate's midx before the primary's loose arm and die on M2. This rules out a merged registry
(DC-5 option c).

#### Pin X — abbreviation across stores

Two blobs sharing the 7-hex prefix `bdd46a6`: X in the donor, Y in the borrower.

| # | command | git |
|---|---|---|
| X1 | `rev-parse --short=7 X` / `Y` in borrower | `bdd46a61` / `bdd46a65` (one longer than in the donor alone, where X → `bdd46a6`) |
| X2 | `rev-parse bdd46a6` in borrower | `error: short object ID bdd46a6 is ambiguous` + `hint:   bdd46a61 blob` + `hint:   bdd46a65 blob`, exit 128 |
| X3 | `rev-parse bdd46a611cee` / `cat-file -p bdd46a611cee` | resolves to the donor object / prints it |

tsgit has no abbreviation renderer (ADR-249); the interop test reconstructs X1 from
`resolveOidPrefix`'s ambiguity data.

### Shape

```
                    objects/info/alternates (bytes)
                               │
        domain  ┌──────────────▼───────────────┐
                │ parseAlternatesFile(bytes)   │  pure: '#', blanks, C-quotes, NUL stop,
                │   → ReadonlyArray<string>    │  separator-skip rule (Pin P)
                └──────────────┬───────────────┘
                               │ entries
   primitives   ┌──────────────▼───────────────┐   port: lstat/readlink/stat/read
                │ resolveObjectSources(ctx)    │   join vs realpath(holding dir) → realpath
                │  DFS, depth ≤ 5, dedupe,     │   → trim '/' → usable? (Pin R/N/D/U)
                │  diagnostics                 │
                └──────────────┬───────────────┘
                               │ ObjectSourceSpec[]  (objectsDir, local, depth, fs)
                ┌──────────────▼───────────────────────────────────────────┐
                │ ObjectStore (per session memo, object-store.ts)          │
                │  sources[0] = primary  { registry, loose cache }         │
                │  sources[i] = alternate{ registry, loose cache }         │
                │  diagnostics                                             │
                └──┬──────────────┬─────────────┬──────────────┬──────────┘
                   │              │             │              │
             read paths     hasObject /    enumerate /     gc / fsck /
           (per source:     objectIsPresent resolveOidPrefix  write probe
            packs→loose)    (any source)   (scope all|local) (local vs all)
```

### D1 — Domain parser (`src/domain/storage/alternates.ts`)

```ts
/** git's `parse_alternates(buf, '\n', …)` over the raw file bytes: entries in file order,
 *  each already C-unquoted; relative/absolute is decided by the caller. */
export const parseAlternatesFile = (bytes: Uint8Array): ReadonlyArray<Uint8Array>;

/** git's `unquote_c_style`: `undefined` when the quoting is broken (caller falls back). */
export const unquoteCStyle = (bytes: Uint8Array, start: number)
  : { readonly value: Uint8Array; readonly end: number } | undefined;
```

Rules, each cited to `odb.c:parse_alternates` (L102–160) and `quote.c:unquote_c_style`:

1. Scan stops at the first NUL (C string; Pin P13).
2. Entry starting with `#` → comment to the next `\n` (column 0 only; P1).
3. Entry starting with `"` → `unquoteCStyle`; success sets `end` **after the closing quote**;
   escapes `\a \b \f \n \r \t \v \\ \"` and 3-digit octal with first digit `0–3`; anything
   else → `undefined`. The quoted span may contain raw `\n` (P9).
4. Otherwise (or on broken quoting) → bytes up to the next `\n`, verbatim — no trimming (P1–P3, P10, P11).
5. After an entry: if not at end, skip **exactly one** byte (P12: the byte after a closing
   quote, whatever it is).
6. Empty entry → skipped.

Returns bytes, not strings: the primitive decodes with `TextDecoder('utf-8', { fatal: true })`;
an entry that is not valid UTF-8 cannot be addressed through a string-path port and is reported
`unresolvable` (tsgit-only edge, recorded in the diagnostic reason; git would address the raw
bytes). Windows absoluteness is the primitive's job (`isAbsolutePath`,
`src/application/primitives/internal/absolute-path.ts`) — the domain stays path-syntax-free.

### D2 — Chain resolution (`src/application/primitives/internal/alternate-chain.ts`)

```ts
export type AlternateDiagnosticReason =
  | 'unresolvable'          // U1 — git: "unable to normalize alternate object path: <path>"
  | 'not-a-directory'       // U2 — git: "object directory <path> does not exist; …"
  | 'unreadable-list'       // U3 — git: "unable to access '<file>': <error text>"
  | 'nesting-too-deep'      // N1 — git: "<path>: ignoring alternate object stores, nesting too deep"
  | 'unreachable';          // tsgit-only: the adapter refused the path (DC-3)

export interface AlternateDiagnostic {
  readonly reason: AlternateDiagnosticReason;
  readonly path: string;            // the path git's message prints (joined path for U1)
  readonly listedIn: string;        // objects dir whose info/alternates named it
  readonly code?: string;           // adapter error code for U3/unreachable
}

export interface ObjectSourceSpec {
  readonly objectsDir: string;      // realpath, trailing '/' trimmed
  readonly local: boolean;          // true only for the primary
  readonly depth: number;           // -1 primary, 0.. alternates
}

export const resolveObjectSources = (ctx: Context, reader: AlternateReader)
  : Promise<{ readonly sources: ReadonlyArray<ObjectSourceSpec>;
              readonly diagnostics: ReadonlyArray<AlternateDiagnostic> }>;
```

Algorithm (git's, `odb.c` L56–205):

```
primaryReal = realpath(commonGitDir/objects)
seen = { primaryReal }; out = [primary]
visit(holder, holderDepth):                                        // primary: holderDepth = -1
  entries = readList(holder)                                       // FILE_NOT_FOUND|NOT_A_DIRECTORY → []; other → 'unreadable-list'
  paths   = entries.flatMap(e => normalise(e, holder))             // whole file first: U1 emitted here, failed entries dropped
  if holderDepth + 1 > 5 && paths.length > 0 → 'nesting-too-deep'(holder); return
  for p in paths:                                                  // git's order of checks:
     if !isDirectory(p) → 'not-a-directory'(p); continue           //   1. is_directory
     if seen.has(p) → continue                                     //   2. self, 3. duplicate — both silent
     seen.add(p); out.push({ p, depth: holderDepth + 1 })
     visit(p, holderDepth + 1)                                     // DFS pre-order (O1)
visit(primary, -1)
```

The primary's entries get depth 0; a holder at depth 5 (n6 in N1) trips the check — six
alternate levels reachable, matching N1/N2.

`normalise(entry, base)`: absolute → entry; else `realpath(base) + '/' + entry`; then
`realpathAllowingMissingLeaf(joined)` — git's `strbuf_realpath(…, die_on_error=0)` resolves every
component and tolerates only a missing **last** component (R3 vs R4); then trim trailing `/`.
How realpath is obtained is DC-4. The depth check placement reproduces N3/N4 exactly
(`sources.nr` counts only normalised entries).

Path equality (self check and dedupe) is git's `dir.c` path comparison — the `odb_path_map`
hash map is declared with its `ignore_case`-aware hash and equality functions (`odb.c` L32):
exact, or ASCII case-insensitive when `core.ignoreCase` is true. The resolver reads `core.ignoreCase` through the existing config reader (as
`walk-working-tree.ts` does) — once per resolution.

### D3 — Object store (`src/application/primitives/object-store.ts`)

```ts
/** Every port method the pack registry, midx loader and loose readers call — nothing that writes. */
export type ObjectSourceReader = Pick<
  FileSystem,
  'read' | 'readUtf8' | 'readSlice' | 'readdir' | 'stat' | 'lstat' | 'exists' | 'readlink'
  | 'openWithNoFollow'
>;
/** Where one source lives; the ONLY thing Part 2 threads through the pack/loose layer. */
export interface SourceLocation {
  readonly objectsDir: string;
  readonly fs: ObjectSourceReader;
}
export interface ObjectSource extends SourceLocation {
  readonly local: boolean;
  readonly registry: PackRegistry;      // per-source; midx gate per source (ADR-592/593 per source)
}
export interface ObjectStore {
  readonly sources: ReadonlyArray<ObjectSource>;     // [primary, ...alternates]
  readonly primary: ObjectSource;
  readonly diagnostics: ReadonlyArray<AlternateDiagnostic>;
  refresh(): void;          // primary.refresh() + mark the list dirty: the next access re-resolves, ADD-only (git odb_reprepare)
  reprepare(): Promise<void>; // every source's registry.reprepare() (miss retry, R5)
  dispose(): Promise<void>;
}
export const getObjectStore: (ctx: Context) => Promise<ObjectStore>;
export const peekObjectStore: (ctx: Context) => ObjectStore | undefined; // repoSettingsVerdictSettled-gated
export const objectSources: (ctx: Context) => Promise<ObjectSourcesView>;  // public, DC-1
```

- `getPackRegistry`/`peekPackRegistry`/`refreshPackRegistry` keep their signatures and
  return/act on the **primary** source's registry, so every local-only consumer (gc,
  pack-objects refresh, fetch-pack refresh) is unchanged by construction.
  `disposePackRegistry` disposes the **whole store** — alternate registries hold persistent
  `FileHandle`s on the donor's packs.
- `refresh()` stays synchronous: it refreshes the primary registry and flags the alternates
  list stale; the next `getObjectStore` re-resolves and **appends** newly-usable sources
  (existing sources and their registries survive, as git's `odb_reprepare` only adds).
- Construction: `Promise.all([createPackRegistry(ctx, primaryLocation), readAlternatesList(primary)])`
  — the list read overlaps the registry's config reads; FILE_NOT_FOUND ⇒ `sources = [primary]`,
  no further I/O. Alternate registries are built only when resolution yields alternates.
- `createPackRegistry(ctx, location?: SourceLocation)`, default
  `{ objectsDir: commonGitDir(ctx) + '/objects', fs: ctx.fs }`. Every `ctx.fs.*` in
  `pack-registry.ts` (10 sites), `internal/midx-source.ts` (5), `internal/pack-artefact-source.ts`
  (3), `internal/pack-byte-source.ts` (2) reads through `location.fs`; config/logger/session stay
  on `ctx` (the borrower's config governs, as in git).
- Loose cache: the primary keeps today's `WeakMap<Session, Map<prefix, Set>>` untouched (hot
  path byte-for-byte the same); alternates use a second `WeakMap<SourceLocation, Map<prefix, Set>>`
  keyed on the **store-owned** location object, which is created once per resolution and is
  therefore stable for the session. A per-call `{ objectsDir, fs }` literal must never be used as
  a key (every call would miss). `probeLooseOid(ctx, id, location?)`, paths via
  `looseObjectPathIn(objectsDir, id)`.

### D4 — Read paths

`resolveObjectContentWithDepth`: primary `assertLoadable()` stays first (ADR-593 for the
primary); then `for (const source of store.sources)`: `await source.registry.assertLoadable()`
**only when reaching an alternate** (M2/M3), `tryResolveViaSource` (packs, then loose of that
source). Full miss → `retryOnceAfterRescan(ctx, store, id, …)` whose rescan is
`store.reprepare()` + `forgetLooseOidPrefix` for every source; the retry re-walks all sources
(git's SECOND_READ pass re-walks every source; it skips loose re-reads, tsgit's cache-forget
is the equivalent of "no stale listing"). REF_DELTA base lookup stays **within the hit's
source registry** (on-disk packs carry their bases; unchanged semantics).

Same per-source loop in: `readObjectMetadataWithContent`, `readDeclaredObjectSize`
(`resolveDeclaredSize`), `openBlobSource`/`verifyStoredObject` (loose-first per ADR-509 **per
source**), `hasObject`'s `probeOnce`, fsck `objectIsPresent`/`hasPackCopy`/
`collectUnreadablePackMemberIds`. `withLazyFetchRetry` (promisor) wraps the whole chain — git
fetches from a promisor only after every source missed.

**Edge — an unreadable directory inside an alternate (U4/U5).** git prints `unable to open
loose object …: Permission denied` and **continues to the next source**. tsgit's existing
posture for the primary is to throw: `loadFanoutSet` tolerates only `FILE_NOT_FOUND`/
`NOT_A_DIRECTORY`, and `listPackDir` warns and treats the directory as empty. Alternates inherit
both unchanged. Observable difference: a read that git would still satisfy from a **later**
source throws `PERMISSION_DENIED` in tsgit; when no later source holds the object, both fail.
This divergence predates the feature (it already applies to the primary) and is recorded here,
not widened; the interop rows U4/U5 assert "read fails" on both tools.

### D5 — Enumeration and abbreviation

- `enumerateObjects(ctx, { scope?: 'all' | 'local' })`, default `'all'` (A5, git's
  `odb_for_each_object` without `ODB_FOR_EACH_OBJECT_LOCAL_ONLY`). Loose: each source's 256
  fanout dirs through `source.fs`; packs: each source's `registry.all()`/`health().accessible`.
- `resolveOidPrefix`: `scanLoose`/`scanPacks` per source, union, ambiguity over the union (X2).
  `MAX_OID_PREFIX_CANDIDATES` unchanged.
- Public behaviour change (changelog, not breaking): in a repository with alternates, the public
  `enumerateObjects`, `hasObject`, `resolveOidPrefix` and every reader now see alternate objects.
  Repositories without an alternates file are unaffected.

### D6 — Write path (DC-10)

Recommended shape: `writeObject` runs a dedicated write probe `presentForWrite(ctx, id)`
**after hashing and before deflate**: every source in order, per source packs then loose —
git's `odb_freshen_object` → `odb_source_files_freshen_object` (`odb/source-files.c:151`) — with
no rescan (git's freshen never re-prepares), and **skipping cruft packs**: a hit in a pack with a
`.mtimes` sibling does not count (`packfile.c:packfile_store_freshen_object` returns 0 for
`is_cruft`, so git writes a fresh loose copy to resurrect the object). `hasObject` cannot be
reused as-is because it counts cruft packs. Present ⇒ return the id, no write. Absent ⇒ unchanged local write. This also removes today's duplicate loose copy
for objects the primary holds packed (a pre-existing divergence, same code path). It is the
"probe-before-deflate" half of backlog 31.10 (d-ii); that item should consume this, not redo it.
`fetch.ts:202` already uses `hasObject(…, 'recheck')` → FE1 holds once `hasObject` is chain-aware.

### D7 — gc / prune

- `owned`: `enumerateObjects(ctx, { includePacks: false, scope: 'local' })` + primary
  `registry.all()` (already primary by D3) — G1/G2.
- The closure walk reads through every source (it must traverse donor commits). The comment in
  `toNormalPackInputs` ("there is no fifth home … false arm unreachable by construction") becomes
  false: an alternate is the fifth home; the `owned.has(id)` guard is now the `-l` behaviour and
  gets its own test.
- `pruneLooseFiles` unlinks only ids from the local `looseSet` (G3).
- `packedAnywhere(ctx, looseSet)` consults **every** source's packs (G4/G5).
- Bitmap closure (`closure-engine.ts:337`) stays primary-only (DC-9).

### D8 — fsck (DC-6, DC-7, DC-8)

- Universe: `enumerateObjects(ctx, { scope: 'all', includePacks: full, accessiblePacksOnly })`.
- Content validation (`content-validation.ts:378`, `object-cache.ts:274`) reads loose bytes from
  the source that holds the id (needs `looseCompressedBytesIn(source, id)`); hash-mismatch /
  corrupt findings unchanged in shape.
- `runPackHealthPass`, `runRevIndexHealthPass`, `runMidxHealthPass`, `runBitmapHealthPass` loop
  over `store.sources` (git: `repo_for_each_pack` over all sources; midx verify per source).
- A Tier-A midx fault in an alternate rejects the run (M4), as for the primary.
- Store diagnostics are not fsck findings in git (they are stderr preamble); F5's exit 10 comes
  from the missing objects. tsgit surfaces them through DC-1's channel.

### D9 — Security (for the security review's sign-off)

- **Read surface added**: for every path named (transitively, ≤ 6 levels) by an
  `info/alternates` inside the repository: `<alt>/info/alternates`, `<alt>/xx/<hex>`,
  `<alt>/pack/` listing, `*.idx|*.pack|*.rev|*.bitmap`, `multi-pack-index`,
  `multi-pack-index.d/*`; plus metadata probes (`lstat`/`readlink`/`stat`) on each component of
  each alternate path for realpath. No other file shape is ever opened.
- **Threat**: a hostile repository author can point alternates anywhere the process can read.
  Disclosure is limited to files that parse as git objects/packs at object-shaped paths and are
  then served as object content — identical to git (ADR-625 §7.2: read escapes are git's model;
  git cannot both support alternates and refuse outside reads). Loose reads do not verify the
  hash by default — same as git; fsck does.
- **Writes**: none outside the primary under DC-10 (a). DC-10 (b) adds an mtime write outside
  the repository and needs its own sign-off.
- **DoS**: depth capped at 6 levels, dedupe makes cycles terminate; the list file is read whole
  (git reads it whole, no cap) — a hostile multi-GB list is the same exposure git has.
- **Containment**: alternates do not widen the main adapter's root set; the reader capability is
  DC-2. Windows: `isAbsolutePath` covers drive/UNC forms; `\\?\` long paths pass through the
  Node adapter unchanged.

### D10 — Diagnostics (DC-1)

Recommended: emitted once per resolution via `ctx.logger?.warn?.('objectStore: unusable
alternate', { reason, path, listedIn })` (house precedent) **and** exposed as data by
`objectSources(ctx)` → `{ sources: [{ objectsDir, local }], unusable: AlternateDiagnostic[] }`.
The view is also the interop oracle for O1 (`count-objects -v` `alternate:` lines).

### Perf statement

- **No alternates file** (the 100 % case today): +1 `fs.read` per session, concurrent with
  `createPackRegistry`'s own config reads (cold path, no serial latency added beyond the
  slower of the two); per object: `peekObjectStore` (one `WeakMap.get`, replacing
  `peekPackRegistry`'s) + a one-element `for…of`. The miss path loops one source.
- **The lookup hot path changes shape** (loop wrapper, store indirection, loose-cache re-key) →
  a `bench:ab` row is required: `cat-file`/`readBlob` warm and cold, `log` walk, `status:clean`
  on a no-alternates fixture, gated at the advisory ±envelope; plus an informational row with a
  `--shared` fixture. Run on Node 24 per #312 notes.
- **Write path** gains a lookup before deflate (DC-10 a/b): cheaper than today when the object
  exists (skips deflate + write); one fanout-bounded binary search + cached loose probe when it
  does not. `add.bench.ts` row.
- With alternates: one resolution per session (≤ components × alternates `lstat`s), one registry
  per alternate built lazily on first reach.

### Part split (dependency order, TDD-sized)

Each part ends green on `npm run validate`.

**Part 1 — `parseAlternatesFile` + `unquoteCStyle` (domain)**
- New: `src/domain/storage/alternates.ts` (+ export from `src/domain/storage/index.ts`),
  `test/unit/domain/storage/alternates.test.ts`, `alternates.properties.test.ts`
  (shared generators in that directory's `arbitraries.ts` if present).
- Examples: every Pin P row as literal bytes.
- Properties: lens 3 totality (never throws on arbitrary bytes, numRuns 200); lens 4
  counting (k column-0 non-`#`, non-`"` lines with no NUL ↔ k entries, 100); lens 1 round-trip
  against an independent test-side C-quoter for paths without `\n` (200).
- No I/O, no `node:`.

**Part 2 — per-source `SourceLocation` refactor (behaviour-preserving)**
- `pack-registry.ts`: `createPackRegistry(ctx: Context, location?: SourceLocation)` (type declared
  here, in `internal/source-location.ts`, with `ObjectSourceReader`); replace the 10
  `ctx.fs.` and 3 `packsDir(commonGitDir(ctx))` sites (`listPackDir`, `createStoreGate`,
  `scanPacks`) with `location`.
- `internal/midx-source.ts` `loadMidxSet(ctx, packsDir, listing)` → add `fs` (5 sites);
  `internal/pack-artefact-source.ts` (3), `internal/pack-byte-source.ts` (2).
- `internal/loose-oid-cache.ts`: functions gain an optional `SourceLocation` (absent = primary,
  today's session-keyed map, unchanged); a present location is keyed by object identity (D3); `path-layout.ts`: add `looseObjectPathIn(objectsDir, id)`,
  `packsDirIn(objectsDir)`.
- Gate: the existing suites unchanged and green (no expectation edits); mutation on touched lines.

**Part 3 — chain resolution (`internal/alternate-chain.ts`)**
- `resolveObjectSources` + realpath per DC-4 + diagnostics per DC-1 + comparator honouring
  `core.ignoreCase`.
- Unit tests on the memory adapter (symlinks supported there): Pins R, N, D, U rows; property:
  resolution terminates and yields distinct `objectsDir`s for an arbitrary directed graph of
  alternates (lens 2, 100).

**Part 4 — `ObjectStore` memo + reader capability**
- New `object-store.ts` (`getObjectStore`, `peekObjectStore`, `objectSources`); re-point
  `read-object.ts` `getPackRegistry`/`peekPackRegistry`/`refreshPackRegistry` at
  `store.primary.registry`; `disposePackRegistry` → `store.dispose()`.
- DC-2/DC-3: `src/repository.ts` (`openRepository`, next to `worktreeFs` at L610), `RuntimeFallback`
  (L301 `makeWorktreeFs`), `src/index.node.ts` L175, `src/ports/context.ts` (`Context` new optional
  field), memory/browser entry points.
- Public export of `objectSources` in `src/application/primitives/index.ts` + `repo.primitives`.

**Part 5 — read paths through the chain**
- `object-resolver.ts`: `resolveObjectContentWithDepth`, `tryResolveViaRegistry` →
  per-source, `readLooseCompressed`/`looseCompressedBytes` take a source.
- `read-object.ts`: `resolveObjectMetadataWithContent`, `resolveDeclaredSize`,
  `readLooseDeclaredSize`, `loosePathFor`.
- `internal/blob-source.ts`: `openBlobSource`, `verifyStoredObject`.
- `has-object.ts`: `probeOnce`; `internal/retry-after-rescan.ts` + `internal/pack-miss-rescan.ts`:
  take the store, `store.reprepare()`, forget prefix in every source.
- Tests: memory-adapter Contexts with a hand-written alternates file; M2/M3 ordering; miss
  retry discovers a pack added to an alternate after first scan.

**Part 6 — enumeration and abbreviation**
- `enumerate-objects.ts` (`scope`), `resolve-oid-prefix.ts` (`scanLoose`, `scanPacks` per source).

**Part 7 — write probe (DC-10)**
- `write-object.ts` `writeObject` + new `internal/present-for-write.ts` (`presentForWrite`):
  per source `registry.lookup` → reject a hit whose pack is cruft (`classifyPackFiles`,
  `pack-registry.ts:389`, over `registry.fileNames()` — zero extra I/O) → `probeLooseOid`.
  `@writes` header unchanged (surface stays `looseObject`). Tests: hit in primary pack (no
  write — today's duplicate goes away), in primary cruft pack (write), in alternate loose/pack
  (no write), absent (write). W1/W4/FE1 interop rows. Under DC-10 (b): a port method + three
  adapters + a write-surface audit entry.

**Part 8 — gc / prune**
- `commands/internal/gc-pipeline.ts` L852 (`scope: 'local'`), `toNormalPackInputs` guard test,
  `packedAnywhere` across sources, `pruneLooseFiles` unchanged input.

**Part 9 — fsck**
- `commands/fsck.ts` L90 universe; `internal/fsck/{object-cache,content-validation,object-presence,
  pack-health,rev-index-health,midx-health,bitmap-health}.ts` per source; finding attribution per
  DC-8 (`internal/fsck/types.ts` pack-class variants L60–93); ADR-412 amendment per DC-7;
  `docs/design/fsck.md` L238/L500/L666.

**Part 10 — interop + parity + bench**
- New `test/integration/alternates-interop.test.ts` using `interop-helpers.ts`
  (`runGit`, `git`, `makePeerPair`, `disableAutoMaintenance`, `tryRunGitWithExit`),
  `pack-fixture-helpers.ts` (`flipEntryBodyByte`, `writeLooseObject`, `readSolePackPair`),
  `midx-fixture-helpers.ts` (`writeMultiPackIndex`, `mutateMidxOrThrow`).
  Remember: build the tsgit Context **after** the git subprocess writes (per-Context loose
  fanout cache).
- Rows: A1–A5, P1–P14 (via `objectSources().sources` vs `count-objects -v`), R1–R8, N1–N4,
  D1–D4, O1, U1–U3 (+U4/U5 as read outcomes), W1/W2/W4/FE1 (no local copy; the mtime half per
  DC-10), G1–G5, F1–F5, M1–M4, X1–X3.
- `test/parity/scenarios/`: one cross-adapter scenario (memory + node) with an in-root
  alternate; one memory row for an out-of-root alternate (DC-3).
- `test/bench/`: rows per §Perf; `npm run bench:ab`.

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| DC-1 | How an unusable alternate (U1–U3, N1, unreachable) is surfaced — tsgit has no stderr | (a) `ctx.logger.warn` only; (b) `logger.warn` **and** a structured `objectSources(ctx)` view `{ sources, unusable[] }`; (c) throw | **(b)** | (a) is invisible without a wired logger; (c) is not git (reads continue). (b) follows the `packRegistry` warn precedent and ADR-249 (data, not text), and is the interop oracle for O1 |
| DC-2 | Read surface for an alternate outside the layout roots (Node refuses lexically today) | (a) per-source **confined** reader from a generalised runtime hook (`makeWorktreeFs` → `makeConfinedFs(roots)`), plus a metadata-only unconfined probe for the realpath walk; (b) one unconfined read-only reader for all alternates; (c) add alternate dirs to the main adapter's root set at open | **(a)** | content reads stay confined to exactly each alternate's objects dir; (c) also widens the **write** guard; (b) is simpler but drops per-source confinement. Needs security sign-off either way |
| DC-3 | Memory / browser behaviour for an out-of-root alternate | (a) memory: adapter `PERMISSION_DENIED` → `unreachable` diagnostic, skip; browser: OPFS resolves the absolute path as-is (readable if that sub-tree exists); (b) throw; (c) report it as git's `not-a-directory` | **(a)** | issue #302 asks "skip with warning rather than throw"; a distinct reason keeps the data honest — git never sees this case |
| DC-4 | Path canonicalisation (git uses `strbuf_realpath`) | (a) emulate realpath through the port (`lstat` + `readlink` walk, missing leaf tolerated); (b) runtime-supplied realpath capability (Node `fs.realpath`, sandboxed lexical); (c) lexical collapse only (`collapsePosixSegments`) | **(a)** | exact on every adapter that has symlinks, lexical where none exist (OPFS); one walk per alternate per session. (c) diverges on D3/D4/O1 and on `..` after a symlinked component |
| DC-5 | Per-source abstraction shape | (a) explicit `ObjectSource`/`SourceLocation` threaded into `createPackRegistry` and the loose cache, `ObjectStore` memo, `getPackRegistry` stays primary; (b) a per-source derived `Context` view (fs swapped) via `deriveContext`; (c) composite `PackRegistry` merging every source behind today's interface | **(a)** | (c) is falsified by M2/M3 (order) and erases local/non-local; (b) forces a fresh session (re-reads config) or a new keep-session exception in `deriveContext` |
| DC-6 | fsck treatment of alternate objects | (a) full parity: universe, content validation, dangling/unreachable, pack/rev/midx/bitmap passes over every source; (b) alternates count for connectivity only; (c) primary only | **(a)** | Pins F2–F4c, M4 — answered by evidence; (b)/(c) would each need a divergence ADR |
| DC-7 | ADR-412 amendment form | (a) edit ADR-412's out-of-scope bullet in place; (b) a new ADR that supersedes that one bullet with scope (ADR-721 → 541 pattern) | **(b)** | keeps 412's history; matches the house supersede-with-scope pattern |
| DC-8 | Pack-class fsck finding attribution across sources (ADR-584 carries the base name only) | (a) add an optional `objectsDir` on pack-class findings, absent for the primary; (b) keep the base name only; (c) put the absolute pack path in `pack` | **(a)** | git prints the absolute alternate path (F4b/F4c); (b) is ambiguous when two sources share a base name; (c) changes the field's meaning for every consumer |
| DC-9 | Acceleration artefacts in an alternate | (a) midx per source (ADR-592/593/597 apply per source — required by M1–M4); pack/midx **bitmaps** and **commit-graph** primary-only; (b) honour all per source as git does; (c) ignore alternates' midx | **(a)** | midx is correctness-bearing (authoritative), so (c) is falsified; bitmaps/commit-graph are perf-only caches — results identical without them; (b) adds bitmap-closure and commit-graph-chain source search (`commit-graph.c` L654–690) for no correctness gain |
| DC-10 | Write path for an object an alternate (or the primary's packs) already holds | (a) probe every source before deflate (cruft packs excluded, as git), skip the write, **no** mtime freshen — divergence ADR; (b) git's freshen: new port capability to set mtime on the holding loose file / `.pack`, local write when it fails (W2b/W3); (c) probe the primary only, write a local copy when only an alternate holds it | **(a)** now, (b) as a follow-up item | cold truth: (a) leaves git's protection against the donor's `gc --prune=<expiry>` deleting a just-reused unreachable object; (b) is the faithful answer but is a port extension + a write outside the repository (security sign-off, write-surface audit) — sized beyond this fence. (c) duplicates what the brief says not to |
| DC-11 | `GIT_ALTERNATE_OBJECT_DIRECTORIES` | (a) unsupported, recorded in an ADR; (b) explicit `openRepository` option `alternateObjectDirectories: string[]` (parsed with `PATH_SEP`, relative to cwd, depth 0); (c) read via `ctx.env` (`EnvReader` — precedent: `GIT_NOTES_REF`, `GIT_SSH_COMMAND`) | **(a)** | fenced OUT. Note the brief's premise "tsgit reads no environment" is already false (`resolve-notes-ref.ts:50`, `ssh-command.ts:20`); (c) would be cheap later |
| DC-12 | When the chain is resolved and re-read | (a) lazily on first object-store access, memoised per session, re-read add-only on `refresh()` (git `odb_reprepare`); (b) eagerly in `openRepository`; (c) re-read on every miss retry | **(a)** | object-free commands pay nothing; (c) is not git (SECOND_READ never re-reads the file); (b) moves I/O into open for every caller. Deviates from the brief's literal "at open", same once-per-session cost |

## Test strategy

- **Domain** (Part 1): example rows = Pin P literal bytes; property sibling (lenses 1, 3, 4).
- **Resolution** (Part 3): memory-adapter unit tests per Pin R/N/D/U row; lens-2 property on
  arbitrary alternate graphs — invariants only, no re-implemented traversal as oracle:
  terminates; `objectsDir`s distinct; every node reachable within six levels appears; every
  source appears after the source whose list named it first (pre-order); depth ≤ 5.
- **Store / read paths** (Parts 4–6): memory-adapter Contexts; isolated guard tests for each
  source-loop exit (hit in primary pack, primary loose, alternate pack, alternate loose, full
  miss → rescan hit in an alternate pack); M2/M3 ordering test; `peekObjectStore` gating.
- **gc / fsck** (Parts 8–9): unit rows mirroring G1–G5 and F1–F5/M4 with a memory store.
- **Interop** (Part 10): `test/integration/alternates-interop.test.ts`, every pin row;
  reconstruct X1 from `ambiguousOidPrefix` data and O1 from `objectSources()`; fsck rows compare
  structured findings + exit bits to git's (ADR-249).
- **Parity**: memory vs node for an in-root alternate; memory out-of-root → `unreachable`.
- **Mutation**: Stryker low mode, narrowed corpus per module (`.claude/workflow/mutation.md`).
- **Perf**: `bench:ab` rows per §Perf.

## Out of scope

- `GIT_ALTERNATE_OBJECT_DIRECTORIES` — fenced; ADR-only (DC-11).
- `objects/info/http-alternates`, dumb HTTP — fenced.
- Producing borrowers: `clone --reference/--shared/--dissociate` options — fenced.
- `repack -a -d` dissociation; a `local` option on tsgit's `packObjects` (git's default includes
  borrowed objects, which tsgit's default already matches) — fenced / not needed.
- Submodule alternates set-up — fenced; a submodule Context reads its own repository's
  alternates file naturally (fresh session).
- Alternate refs as negotiation `.have`s (`core.alternateRefsCommand`, `for_each_alternate_ref`)
  — fetch negotiation optimisation; FE1's "already have" holds without it.
- Commit-graph and bitmaps hosted in an alternate — perf-only (DC-9).
- git's freshen (mtime) on an alternate — DC-10 (b), follow-up.
- A rendered `count-objects` command — not needed; `objectSources()` carries the data.
