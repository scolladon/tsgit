# Design — alternates object lookup (`objects/info/alternates`)

> Brief: read objects through `objects/info/alternates` the way canonical git 2.55.0 does —
> every read, existence probe, abbreviation and enumeration falls through the alternate chain
> (loose, packs, midx); the alternates file is parsed exactly as `parse_alternates` parses it;
> writes stay local but count alternate objects as present; `fsck`/`gc`/`prune` treat alternate
> objects as present-but-not-local; all I/O through the `FileSystem` port; zero per-object cost
> for repositories without an alternates file. Issue #302 (sfdx-git-delta discussion #1457:
> `ParameterIsNotGitSHA` on a Bamboo cached checkout).
>
> Status: draft → decisions ratified (ADR-914 … ADR-924) → revised against them (scope folded:
> full git freshen on write, every acceleration file per source) → DC-13 … DC-16 ratified
> (ADR-925 … ADR-928) → **revision #2** (scope folded: git's stream-open order for streamed
> blob reads, §D4.1, Pin M5 widened) → self-reviewed ×3 → 3 new decision candidates
> (§Decisions, DC-17 … DC-19).
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
>    git does not merely skip the write: it **freshens** the holding copy (`utime(fn, NULL)` on
>    the loose file or the `.pack`, in whichever source holds it — the primary included, pins
>    W1/W2/WP1/WP2) and writes a local copy only when no source could be freshened (W2b/W3/WP2b).
>    tsgit has no mtime-setting port operation today, and the write path has no existence probe
>    at all (it relies on `writeExclusive`'s `FILE_EXISTS`), so it already writes a duplicate
>    loose copy of any object the **primary** holds packed. ADR-922 adopts git's freshen (§D6, §D11).
>
> A fourth finding came out of the revision's pins: tsgit's commit-graph loader treats a chain
> with a missing layer, and a corrupt single-file graph, as **absent**; git uses the chain's
> loadable **prefix** (CG4) and, for a corrupt single file, falls through to the chain and then
> to the next source (CG6). ADR-921 ("git's failure handling") makes the source-aware loader
> adopt both — a behaviour change for repositories without alternates too (speed only, never
> answers).

<!-- cspell:ignore chflags uchg utimes chattr incore delt typep -->

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
| write | `write-object.ts` (`writeObject`: serialize → deflate → `writeExclusive`; `FILE_EXISTS` ⇒ already present) | no pre-write existence probe, no freshen |
| promisor missing-set | `commands/fetch-missing.ts:57` (`objectExistsLocally`: `ctx.fs.exists(looseObjectPath)` + `registry.lookup`) | primary only |
| commit-graph | `internal/read-commit-graph.ts` (`loadGraphUncached` → `tryRead(commitGraphPath)` else `loadChain`; memo `graphCache`/`absentGraphs`/`headerCache` per session; callers `merge-base.ts`, `walk-commits.ts`, `internal/{shallow-set,read-commit-meta,commit-date-walk}.ts` via `commitHeader`/`correctedCommitDatesEnabled`) | `commonGitDir(ctx)` + `ctx.fs`; missing layer or corrupt file ⇒ whole graph absent |
| bitmaps | `internal/closure-engine.ts` (`tryBitmapClosure`: primary `registry.midxBitmap()` → `loadMidxBitmapArtefact`, then each `registry.all()` pack → `loadPackBitmapArtefact`); loaders `internal/{midx,pack}-bitmap-binding.ts`, bytes via `pack-artefact-source.ts:loadBitmapBytes`; callers `push.ts:451`, `pack-objects.ts:82`, `rev-list.ts:126` (gc pins `'walk'`, `gc-pipeline.ts:60`) | primary registry only |
| gc / prune | `commands/internal/gc-pipeline.ts` (`owned` from `enumerateObjects(ctx,{includePacks:false})` + `registry.all()`; `toNormalPackInputs`; `packedAnywhere`; `pruneLooseFiles`) | primary only |
| fsck | `commands/fsck.ts` (universe = `enumerateObjects`), `internal/fsck/{object-cache,content-validation,pack-health,rev-index-health,midx-health,bitmap-health,object-presence,refs-verify}.ts` | primary only; **no commit-graph verification pass exists** |

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
| ADR-914 … ADR-928 | this feature's ratified decisions — mapping in §Decisions |
| ADR-412 | fsck scope bullet *"alternate object stores (tsgit has no alternates)"* — superseded by ADR-919 |
| ADR-138 / ADR-140 | `@writes` tag grammar and the three comparison kinds — the freshen write surface (§D11) |
| ADR-509 | loose-first precedence + loose oid cache (`hasObject` arm, in-core blob order) — the streamed open's per-source arms are git's instead (ADR-928, §D4.1) |
| ADR-584 | a pack finding carries the pack **base name** — refined by ADR-920 (`objectsDir`) |
| ADR-592/593 | midx authoritative for its packs; Tier-A die / Tier-B discard — per source (Pin M) |
| ADR-597 | usable midx defers `.idx` loading — per source |
| ADR-601 | fsck reports midx findings — git runs `multi-pack-index verify --object-dir <source>` **per source** (`builtin/fsck.c` L1173) |
| ADR-625 / ADR-721 / ADR-298 | read containment lexical, single authority in first-party adapters; widened fs via runtime hook |
| `docs/design/midx-read-support.md` L6 / item 7 | midx-in-an-alternate to be re-decided once alternates land — decided by ADR-921 |
| `docs/design/fsck.md` L238, L500, L666 | `full` documented as "alternates out of scope" — amended per ADR-919 |

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
  (buffered reads: packs, midx-gated, then loose — git's `odb_source_files_read_object_info`).
  A source is never consulted before every earlier source has missed (Pin M2/M3).
- **R1b** A streamed open (the reads git serves through `odb/streaming.c:istream_source`) follows
  git's stream-open order across sources, fall-through included, then the in-core read (ADR-928,
  §D4.1, Pin M5); every other blob read keeps R1's in-core order.
- **R2** `parseAlternatesFile` reproduces `odb.c:parse_alternates` + `quote.c:unquote_c_style`
  byte-for-byte on every row of Pin matrix P (comments, blanks, quoting, NUL, CR, trailing
  space, quote spanning lines, broken quote fallback, trailing text after a closing quote).
- **R3** Chain resolution reproduces `odb_add_alternate_recursively` + `odb_is_source_usable`:
  relative to the realpath of the **holding** objects dir; realpath-normalised; trailing slashes
  trimmed; self and duplicates skipped silently (by realpath); depth-first; a source at depth 5
  with ≥1 normalised entry stops with *nesting too deep*; cycle-safe.
- **R4** An unusable alternate never fails a read: it is skipped and reported as a structured
  diagnostic (ADR-914), classified like git's three messages (Pin U).
- **R5** A full miss re-prepares **every** source's pack registry and forgets the missed id's loose
  prefix in **every** source; the alternates file itself is re-read only on `refresh()`
  (git's `odb_reprepare`), add-only (ADR-924).
- **R6** Writes land only in the primary. Before deflate, `writeObject` runs git's
  `odb_freshen_object` over every source (cruft packs excluded); a successful freshen of the
  holding loose file or `.pack` skips the write; otherwise the object is written locally
  (ADR-922, Pin W).
- **R7** `gc` packs, crufts and prunes **local** objects only; its reachability walk reads through
  alternates; its "already packed" sweep (`packedAnywhere`) counts alternate packs (Pins G1–G5).
- **R8** `fsck` audits every source as git does (Pins F1–F5, M1); ADR-919 supersedes ADR-412's bullet.
- **R9** All alternate I/O goes through the `FileSystem` port; no `node:` import outside
  `src/adapters/`; behaviour on memory/browser defined (ADR-916).
- **R10** A repository without `objects/info/alternates` pays one extra `read` per session
  (FILE_NOT_FOUND), issued concurrently with the primary registry construction, and nothing per
  object **read** beyond iterating a one-element source array; the write path pays a pack lookup
  + a cached loose probe per write and one `utimeNow` per write of an object that already exists,
  and one header-only type probe per ref-target verification (§D4.1) (§Perf); `bench:ab` shows no
  regression.
- **R11** 100 % coverage, zero surviving non-equivalent mutants, interop pins for every row below.
- **R12** Every acceleration file is honoured per source with git's search order and failure
  handling (ADR-921): midx (Pin M), commit-graph single file and split chain (Pin CG), pack and
  midx bitmaps (Pin BM). fsck covers each source's acceleration files to the extent tsgit's fsck
  verifies that class today: midx and bitmaps yes; commit-graph — tsgit's fsck has no
  commit-graph pass, so nothing is added (git's per-source `commit-graph verify` stays out, as it
  is for the primary today).
- **R13** The `FileSystem` port gains an **optional** `utimeNow(path)` (§D11); node and memory
  implement it, the browser adapter omits it (ADR-925); an alternate's capability carries it,
  confined to that alternate's objects dir (ADR-915).

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

Source (git 2.55.0): `odb/source-loose.c:odb_source_loose_write_object` calls
`odb_freshen_object(odb, oid)` after hashing and **before** deflating; `1` ⇒ return without
writing. `odb.c:826 odb_freshen_object` = `odb_prepare_alternates` + every source in order,
first `1` wins. Per source, `odb/source-files.c:151` tries **packs, then loose**:

- `packfile.c:2172 packfile_store_freshen_object`: `find_pack_entry` (prepares the source's pack
  store — midx first, then non-midx packs — and takes the **first** pack that holds the id);
  `is_cruft` ⇒ `0` **without trying another pack**; `p->freshened` ⇒ `1` with no syscall (once
  per pack instance per process); else `utime(p->pack_name, NULL)` — the `.pack`, never
  `.idx`/`.rev`/`.bitmap`/`.mtimes`/`multi-pack-index`; failure (any errno) ⇒ `0`; success sets
  `freshened`.
- `odb/source-loose.c:576` → `object-file.c:81 check_and_freshen_file(path, 1)`:
  `access(F_OK)` fails (any errno) ⇒ `0`; `object-file.c:69 freshen_file` = `!utime(fn, NULL)`;
  failure ⇒ `0`.
- A `0` in one source moves to the **next** source; nothing is written until every source has
  returned `0`. `utime(fn, NULL)` sets atime and mtime to now; it needs ownership **or** write
  permission.

Every row: objects made **reachable** (committed) before `repack -ad`, so they really are packed;
mtimes back-dated with `touch -t 200101010000`; immutability via `chflags uchg` (macOS).

| # | setup | git |
|---|---|---|
| W1 | donor holds X **loose** (mtime 2001); borrower `hash-object -w` X | **no** local file; donor's loose file mtime → now |
| W2 | donor holds X **packed** (`.pack/.idx/.rev` 2001) | no local file; donor `.pack` → now; `.idx`/`.rev` untouched |
| W2m | donor holds X in a midx-covered pack (two packs + `multi-pack-index`, all 2001) | no local file; the `.pack` holding X → now; `multi-pack-index`, `.idx`, `.rev` and the other pack untouched |
| W2b | W2 with the donor `.pack` immutable | freshen fails → local loose copy written; donor files unchanged |
| W3 | donor loose X immutable | freshen fails → local loose copy written; donor mtime unchanged |
| W4 | borrower `commit` whose tree is the donor's tree | only the new commit is written locally |
| W5 | donor midx signature smashed; borrower `hash-object -w` a **new** object | `fatal: multi-pack-index signature 0x58585858 does not match signature 0x4d494458`, 128, nothing written — the freshen probe prepares every source's pack store (ADR-593 Tier A fires there, as M3) |
| WP1 | **primary** holds Y loose (2001); `hash-object -w` Y | loose file mtime → now |
| WP2 | primary holds Y packed (2001) | `.pack` → now; `.idx`/`.rev` untouched; **no loose copy** (tsgit writes one today) |
| WP2b | WP2 with the `.pack` immutable | loose copy written; pack files unchanged |
| WP3 | primary holds Y **only in a cruft pack** (`repack --cruft`; 2001) | loose copy written; cruft `.pack`/`.mtimes`/`.idx`/`.rev` and the normal pack untouched |
| WP4 | primary loose Y immutable **and** donor loose Y (both 2001) | primary file unchanged; donor loose → now; nothing written — a failed freshen moves on to the next source |
| WP5 | primary `.pack` holding Y immutable, no primary loose, donor loose Y | primary pack unchanged; donor loose → now; no local file |
| WP6 | donor `.pack` holding Y immutable **and** donor loose Y | donor pack unchanged; donor loose → now; no local file — packs then loose within one source |
| WP7 | primary holds Y both loose and packed (all 2001) | `.pack` → now; loose untouched — the pack arm answers first |
| WP8 | donor `.pack` mode `0444`, owned by the caller | `.pack` → now — permission bits do not block the owner |
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
| M5 | same; the borrower holds blob B **packed locally**, B below `core.bigFileThreshold` | `cat-file -t B` exit 0; **`cat-file blob B` dies with the M3 fatal**, 128 — full matrix below |

#### Pin M5 — the streamed open across sources (ADR-928)

Source (git 2.55.0). `odb/streaming.c:istream_source` (called by `odb_read_stream_open`):

```
odb_prepare_alternates(odb)
for source in odb->sources:                        // primary, then git's DFS order
  if odb_source_read_object_stream(source, oid) == 0 → stream from it
return open_istream_incore(odb, oid)               // odb_read_object_info_extended(…, DIE_IF_CORRUPT)
```

- Per source, `odb/source-files.c:odb_source_files_read_object_stream`: **pack arm, then loose arm**.
- Pack arm, `packfile.c:packfile_store_read_object_stream` → `find_pack_entry` (runs
  `packfile_store_prepare` — the source's pack dir listing **and its midx load**, where ADR-593's
  Tier A dies, M3 — then midx entry, then non-midx packs; `fill_pack_entry` also proves the pack
  opens) → `packfile_read_object_stream`: reads the entry header, then **declines when
  `bigFileThreshold >= size`** (`size` = the entry header's size — for a delta, the delta's), then
  declines every delta type (`OFS_DELTA`/`REF_DELTA`: "we do not do deltas for now"); `OBJ_BAD`
  marks the entry bad and declines; commit/tree/blob/tag above the threshold → streamed.
- Loose arm, `odb/source-loose.c:odb_source_loose_read_object_stream`: any loose object, any type,
  any size; declines only when the file is absent or unreadable, or its header does not unpack/parse.
- `core.bigFileThreshold`: `repo-settings.c:repo_settings_get_big_file_threshold`, read once per
  process, default 512 MiB.
- In-core fallback (`open_istream_incore`): the ordinary buffered read — every source again from
  the primary, packs then loose, `SECOND_READ` rescan on a full miss. Its answer is the first
  holder; every source's pack store is already prepared by then.
- Callers that stream: `cat-file blob`/`-p <blob>` (`builtin/cat-file.c:stream_blob`),
  `cat-file --batch` blob contents (`print_object_or_die`), `show <blob>` (`builtin/log.c`), checkout
  of a regular file whose conversion is streamable (`entry.c:write_entry` →
  `streaming_write_entry`; a symlink or an in-core filter reads in-core), `parse_object` of a
  **blob** (`object.c:parse_object_with_flags` — type probe first, a non-blob reads in-core),
  archive and pack-objects for blobs above the threshold only. `diff` reads in-core
  (`diff.c:diff_populate_filespec`).

Matrix. Borrower `b` (`clone --shared donor`) commits `f` (blob B = `small\n`, 6 bytes), `delt`
(13 890 bytes, stored **non-delta**), `base` (stored as a 17-byte **delta** against `delt`) and a
symlink `lnk → f`; `git repack -ad`; no borrower object is loose. Donor: `repack -ad` +
`multi-pack-index write`, signature smashed to `XXXX`. "fatal" = the M3 line, exit 128.
Script: scratchpad `alt-probe-m5{,b,c}.sh`.

| # | command in `b` | git |
|---|---|---|
| M5a | `cat-file -t B`; `cat-file --batch-check` (B); `rev-parse HEAD:f`; `cat-file -p HEAD`; `cat-file --batch` (HEAD's tree) | exit 0 — info and in-core reads stop at the primary's pack |
| M5b | `cat-file blob B`; `cat-file -p B`; `cat-file --batch` (B); `show B`; `show HEAD:f` | fatal — the pack arm declines a small B, the primary's loose arm misses, the donor's pack store is prepared |
| M5c | `-c core.bigFileThreshold=5 cat-file blob B` (size 6 > 5) | exit 0 — the primary's pack arm streams B; the donor is never prepared |
| M5d | `-c core.bigFileThreshold=6 cat-file blob B` (size 6) | fatal — `threshold >= size` declines (strict `>`) |
| M5e | `-c core.bigFileThreshold=1 cat-file blob <delt>` (non-delta) | exit 0 |
| M5f | `-c core.bigFileThreshold=1 cat-file blob <base>` (delta) | fatal — a delta is never streamed by the pack arm, whatever its size |
| M5g | `update-ref refs/tags/tb B` | fatal — `parse_object` streams a blob |
| M5h | `update-ref refs/tags/tc HEAD` | exit 0 — `parse_object` reads a commit in-core |
| M5i | `rm f; checkout -- f` | fatal; **`f` left as an empty file** (the output is opened before the stream; `die` skips the unlink), no `index.lock` |
| M5j | `rm lnk; checkout -- lnk` | exit 0 — a symlink is read in-core |
| M5k | `diff --stat -w HEAD~1 HEAD` | exit 0 — diff reads in-core. (`diff` with a patch or `--raw` dies, through the every-source oid **abbreviation** scan of Pin X, not through a read — tsgit renders no abbreviation, ADR-249) |
| M5l | B **also loose** in the primary (file copied in; `hash-object -w` would freshen the pack instead, WP2) | `cat-file blob B`, `checkout -- f` exit 0 — the primary's loose arm streams it |
| M5m | `archive HEAD` | exit 0 — archive streams only blobs above the threshold |

Two consequences. (1) The stream order is a **per-caller** property: the same object read by
`cat-file -t`, `diff` or `parse_object` of a commit never reaches a later source. (2) With **one**
source the fall-through reaches nothing new, so a repository without alternates sees no
observable change beyond the arm order inside the primary (pack arm for a large non-delta object
before the loose arm; §D4.1).

M2/M3 are only consistent with git's **per-source** order (primary packs → primary loose →
alternate packs → …). A "all packs of all sources, then all loose" order would load the
alternate's midx before the primary's loose arm and die on M2. This rules out a merged registry
(ADR-918 option 3).

#### Pin X — abbreviation across stores

Two blobs sharing the 7-hex prefix `bdd46a6`: X in the donor, Y in the borrower.

| # | command | git |
|---|---|---|
| X1 | `rev-parse --short=7 X` / `Y` in borrower | `bdd46a61` / `bdd46a65` (one longer than in the donor alone, where X → `bdd46a6`) |
| X2 | `rev-parse bdd46a6` in borrower | `error: short object ID bdd46a6 is ambiguous` + `hint:   bdd46a61 blob` + `hint:   bdd46a65 blob`, exit 128 |
| X3 | `rev-parse bdd46a611cee` / `cat-file -p bdd46a611cee` | resolves to the donor object / prints it |

tsgit has no abbreviation renderer (ADR-249); the interop test reconstructs X1 from
`resolveOidPrefix`'s ambiguity data.

#### Pin CG — commit-graph in an alternate

Source: `commit-graph.c:738 prepare_commit_graph` — for each source in order,
`read_commit_graph_one` (single file `info/commit-graph`, else the chain
`info/commit-graphs/commit-graph-chain`); the **first source that yields a graph wins** — graphs
are never merged across sources. `load_commit_graph_chain_fd_st` (L641): for each chain line
(base first), search **every source** in order for `info/commit-graphs/graph-<hash>.graph`; the
first source whose file loads is used (a missing or unparsable file moves to the next source); a
line no source satisfies ⇒ `warning: unable to find all commit-graph files`, stop, and **keep the
layers loaded so far**. A chain whose first layer is unresolvable yields no graph from that source,
and the search moves to the next source. Observable used below: with a graph, `rev-list --count`
parses parents from the graph and never opens covered commit objects; a deleted covered commit
object therefore fails only without the graph (`-c core.commitGraph=false` is the control).

| # | setup | `git -C borrower rev-list --count HEAD` |
|---|---|---|
| CG1 | donor `commit-graph write --reachable` (single file), borrower has none; donor's `HEAD~2` commit object deleted | `4`, exit 0 (control: `Could not read …`, 128) — the donor's graph is used |
| CG2 | borrower single graph covering `c1..c2` only, donor graph covering all; donor's `c3` object deleted | `error: Could not read <c3>` / `fatal: Failed to traverse parents …`, 128 (donor alone: `4`) — the primary's graph wins, the donor's is never consulted |
| CG3 | donor `--split` chain (layer L1); borrower commits and runs `commit-graph write --reachable --split=no-merge` | borrower's chain file lists `L1, L2`; `graph-L1.graph` exists **only in the donor**; with `c1`'s object deleted → `3`, exit 0 (control fails) — layer L1 is found in the donor |
| CG4 | CG3, borrower's tip layer L2 file removed | `warning: unable to find all commit-graph files`, `3`, exit 0 — the loaded prefix (L1) is used |
| CG4b | CG3, donor's base layer L1 file removed | the warning printed **twice** (borrower chain, then donor chain), then `Could not read …`, 128 — no graph |
| CG5 | borrower chain file naming one non-existent layer; donor single graph; donor `c1` deleted | warning once, then `3`, exit 0 — an empty prefix moves on to the next source |
| CG6 | borrower single `info/commit-graph` = garbage; donor single graph; donor `c1` deleted | `error: commit-graph file is too small`, `3`, exit 0 — corrupt file ⇒ that source's chain, then the next source |

#### Pin BM — bitmaps in an alternate

Source: `pack-bitmap.c:721 open_bitmap` — **one** bitmap per process: first `open_midx_bitmap`
over **every source's** midx in order (L704), and only if none opened, `open_pack_bitmap` over
`repo_for_each_pack` (every source's packs, source order). A later candidate is reported (trace2)
as `ignoring extra [midx ]bitmap file` and not used. A borrower cannot write a bitmap with `-l`
(`warning: disabling bitmap writing, as some objects are not being packed`), so the borrower-side
bitmaps below come from `repack -adb` **without** `-l`. Observation: `GIT_TRACE2_EVENT`
`category: bitmap` data of `rev-list --use-bitmap-index --count --objects HEAD`.

| # | setup | git |
|---|---|---|
| BM1 | donor pack bitmap only | `opened bitmap file: <donor>/objects/pack/pack-….pack` |
| BM2 | borrower pack bitmap + donor pack bitmap | borrower's opened; `ignoring extra bitmap file: <donor pack>` |
| BM3 | borrower **pack** bitmap + donor **midx** bitmap | donor midx bitmap loaded (`load/num_objects: 9`); `ignoring extra bitmap file: <borrower pack>` — every source's midx bitmap outranks every pack bitmap |
| BM4 | midx bitmap in both | borrower's loaded (12 objects); `ignoring extra midx bitmap file: <donor>/objects/pack/multi-pack-index` |
| BM5 | donor pack bitmap with a smashed header, the only bitmap | `error: corrupted bitmap index file (wrong header)` (×2), walk fallback, same count, exit 0 |
| BM6 | borrower pack bitmap, donor midx signature smashed | `fatal: multi-pack-index signature …`, 128 (`rev-list` without the bitmap: exit 0) — opening bitmaps prepares every source's midx |

fsck: `pack-bitmap.c:verify_bitmap_files` (called from `builtin/fsck.c:1150`) checks every
source's midx bitmap, then every source's pack bitmaps — tsgit's `bitmap-health` pass loops
sources the same way (§D8).

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
                               │ ObjectSourceSpec[]  (objectsDir, local, depth)
                ┌──────────────▼───────────────────────────────────────────┐
                │ ObjectStore (per session memo, object-store.ts)          │
                │  sources[0] = primary  { fs=ctx.fs, registry, loose }    │
                │  sources[i] = alternate{ fs=confined(objectsDir),        │
                │                          registry, loose }               │
                │  diagnostics                                             │
                └──┬──────────┬──────────┬───────────┬──────────┬─────────┘
                   │          │          │           │          │
             read paths  hasObject / enumerate /  writeObject  commit-graph /
           (per source:  objectIsPresent resolveOid  → freshen  bitmaps / gc /
            packs→loose) (any source)  Prefix      (utimeNow,  fsck
                                       (all|local)  any source) (per source)
```

A source's `fs` is its only I/O handle: reads plus the optional `utimeNow` (§D3, §D11).

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
  | 'unreachable';          // tsgit-only: the adapter refused the path (ADR-916)

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

/** The two capabilities resolution needs: a metadata probe for any path (realpath walk,
 *  is-directory), and the confined reader of a usable source (its own `info/alternates`). */
export interface AlternateChainIo {
  readonly probe: (path: string) => AlternatePathProbe;
  readonly reader: (objectsDir: string) => ObjectSourceReader;
}

export const resolveObjectSources = (ctx: Context, io: AlternateChainIo)
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
Realpath is emulated through the port (ADR-917) with `AlternatePathProbe`. The depth check placement reproduces N3/N4 exactly
(`sources.nr` counts only normalised entries).

Path equality (self check and dedupe) is git's `dir.c` path comparison — the `odb_path_map`
hash map is declared with its `ignore_case`-aware hash and equality functions (`odb.c` L32):
exact, or ASCII case-insensitive when `core.ignoreCase` is true. The resolver reads `core.ignoreCase` through the existing config reader (as
`walk-working-tree.ts` does) — once per resolution.

### D3 — Object store (`src/application/primitives/object-store.ts`)

```ts
// src/ports/object-source-access.ts — port layer, because `Context` (src/ports/context.ts) names them
/** Every port method the pack registry, midx loader, loose readers and commit-graph loader call. */
export type ObjectSourceReader = Pick<
  FileSystem,
  'read' | 'readUtf8' | 'readSlice' | 'readdir' | 'stat' | 'lstat' | 'exists' | 'readlink'
  | 'openWithNoFollow'
>;
/** A source's whole I/O capability: its reads plus git's one foreign write, the freshen. */
export type ObjectSourceAccess = ObjectSourceReader & Pick<FileSystem, 'utimeNow'>;
/** Metadata-only probe for the realpath walk (ADR-915, ADR-917) — opens no file content. */
export type AlternatePathProbe = Pick<FileSystem, 'lstat' | 'readlink' | 'stat'>;

// src/application/primitives/internal/source-location.ts
/** Where one source lives; the ONLY thing Part 3 threads through the pack/loose layer. */
export interface SourceLocation {
  readonly objectsDir: string;
  readonly fs: ObjectSourceAccess;
}

// src/application/primitives/object-store.ts
export interface ObjectSource extends SourceLocation {
  readonly local: boolean;
  readonly registry: PackRegistry;      // per-source; midx gate per source (ADR-592/593 per source)
}
export interface ObjectStore {
  readonly sources: ReadonlyArray<ObjectSource>;     // [primary, ...alternates]
  readonly primary: ObjectSource;
  readonly diagnostics: ReadonlyArray<AlternateDiagnostic>;
  readonly bigFileThreshold: number;  // core.bigFileThreshold, once per store (git: once per process), §D4.1
  refresh(): void;          // primary.refresh() + mark the list dirty: the next access re-resolves, ADD-only (git odb_reprepare)
  reprepare(): Promise<void>; // every source's registry.reprepare() (miss retry, R5)
  dispose(): Promise<void>;
}
export const getObjectStore: (ctx: Context) => Promise<ObjectStore>;
export const peekObjectStore: (ctx: Context) => ObjectStore | undefined; // repoSettingsVerdictSettled-gated
export const objectSources: (ctx: Context) => Promise<ObjectSourcesView>;  // public, ADR-914
```

- **Capability construction (ADR-915).** The primary's `fs` is `ctx.fs` (already guarded). An
  alternate's `fs` is built by `Context.objectSourceAccess?.(objectsDir)`, which the facade
  (`src/repository.ts`, beside `worktreeFs` L610) derives from a new runtime hook
  `RuntimeFallback.makeConfinedFs?: (roots: ReadonlyArray<string>) => FileSystem` (Node:
  `src/index.node.ts`, beside `makeWorktreeFs` L175 — the same `NodeFileSystem` construction
  with `roots = [objectsDir]` and **no** layout roots). The facade does not hand the adapter out:
  it builds a fresh object carrying exactly the `ObjectSourceAccess` members, bound to the
  confined adapter — `openWithNoFollow(path, 'write')` refused with `PERMISSION_DENIED`, no
  `write*`/`rm*`/`mkdir`/`rename`/`chmod`/`symlink` member at all — memoised per `objectsDir`
  like `worktreeFsCache`. The adapter's own write guard confines `utimeNow` to the alternate's
  objects dir; its leaf check refuses a symlink leaf (§D11). The facade also wraps `utimeNow` in a
  lexical check — the path must lie under `objectsDir` with no `..` segment — so the confinement
  holds when there is no hook and the capability is a narrowed `ctx.fs` (memory, browser, user
  fs). The realpath walk uses `Context.alternatePathProbe?.(path)`: the same hook rooted at the path's filesystem root
  (`/`, a drive root, or a UNC share), narrowed to `AlternatePathProbe`. Absent hook (memory,
  browser, a user `opts.fs` without it): both fall back to narrowing `ctx.fs` itself — memory
  refuses an out-of-root path and the alternate is skipped as `unreachable` (ADR-916); OPFS
  resolves it in its sandbox.
- `getPackRegistry`/`peekPackRegistry`/`refreshPackRegistry` keep their signatures and
  return/act on the **primary** source's registry, so every local-only consumer (gc,
  pack-objects refresh, fetch-pack refresh) is unchanged by construction.
  `disposePackRegistry` disposes the **whole store** — alternate registries hold persistent
  `FileHandle`s on the donor's packs.
- `refresh()` stays synchronous: it refreshes the primary registry and flags the alternates
  list stale; the next `getObjectStore` re-resolves and **appends** newly-usable sources
  (existing sources and their registries survive, as git's `odb_reprepare` only adds).
- Construction: `Promise.all([createPackRegistry(ctx, primaryLocation), readAlternatesList(primary),
  readBigFileThreshold(ctx)])` — the list read overlaps the registry's config reads, and the
  threshold's `readConfig` falls in the same per-session coalescing window as the registry's two
  budget reads (no extra stat); FILE_NOT_FOUND ⇒ `sources = [primary]`, no further I/O. Alternate
  registries are built only when resolution yields alternates. The threshold is not re-read on
  `refresh()` (git memoises it in `repo->settings`).
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
(`resolveDeclaredSize`, generalised to `resolveDeclaredHeader`, §D4.1), `openBlobSource` in its
`'in-core'` order (loose-first per ADR-509 **per source**; the `'stream'` order is §D4.1),
`hasObject`'s `probeOnce`, fsck `objectIsPresent`/`hasPackCopy`/
`collectUnreadablePackMemberIds`, fsck `refs-verify.ts:isKnownOid` (via `objectIsPresent`), and
`fetch-missing.ts:objectExistsLocally` (the promisor missing-set must not re-fetch an object an
alternate holds). `withLazyFetchRetry` (promisor) wraps the whole chain — git fetches from a
promisor only after every source missed. `ref-store.ts:1099` (`looseBodyFinding`'s loose-only
`badRefOid`) stays primary-only: its only consumer, fsck's refs-verify, keeps `badRefContent`
findings alone (`refs-verify.ts:collectBadContentNotices`), so it never surfaces for a borrower.

**Edge — an unreadable directory inside an alternate (U4/U5).** git prints `unable to open
loose object …: Permission denied` and **continues to the next source**. tsgit's existing
posture for the primary is to throw: `loadFanoutSet` tolerates only `FILE_NOT_FOUND`/
`NOT_A_DIRECTORY`, and `listPackDir` warns and treats the directory as empty. Alternates inherit
both unchanged. Observable difference: a read that git would still satisfy from a **later**
source throws `PERMISSION_DENIED` in tsgit; when no later source holds the object, both fail.
This divergence predates the feature (it already applies to the primary) and is recorded here,
not widened; the interop rows U4/U5 assert "read fails" on both tools.

### D4.1 — Streamed blob open: git's stream order (ADR-928, Pin M5)

**Today.** `openBlobSource(ctx, id, maxBufferedBytes, options?)` (`internal/blob-source.ts`):
primary `registry.assertLoadable()` → delta-cache fast path (`tryDeltaCacheHit`, skipped at
`NEVER_BUFFER`) → `tryOpenBlobSource`: loose (`looseCompressedBytes`) → pack (`registry.lookup` →
`readEntryHeaderWithChunk` → `resolvePackBase` | `resolvePackDelta`) → full miss →
`retryOnceAfterRescan`. `maxBufferedBytes` (64 KiB compressed, or `NEVER_BUFFER`) decides only
the **representation** (`bytes` vs `stream`) — a memory policy with no git analogue. Nothing in
the read path knows `core.bigFileThreshold`: its only reader is fsck
(`commands/internal/fsck/read-configuration.ts`, `DEFAULT_BIG_FILE_THRESHOLD_BYTES`, default
applied by the caller; `config-read.ts` parses `core.bigFileThreshold` leniently).

**New.** `openBlobSource` takes a required `order: BlobReadOrder` (`'stream' | 'in-core'`) in its
internal options, and splits into *locate* (which source and arm answer — git's routing, where
every fault fires) and *serve* (today's `resolveLoose` / `resolvePackBase` / `resolvePackDelta`,
still gated by `maxBufferedBytes`). git's pack-arm acceptance rule is therefore reproduced as a
**routing** rule on `store.bigFileThreshold`, never as a buffering rule: a large object routed to
the in-core arm is still streamed by tsgit when it exceeds `maxBufferedBytes`, and a small one
routed to the pack arm is still buffered.

```
openBlobSource(ctx, id, maxBufferedBytes, { order, verifyHash?, looseMode? }):
  store = peekObjectStore(ctx) ?? await getObjectStore(ctx)
  await store.primary.registry.assertLoadable()           // unchanged entry gate
  if order === 'in-core': cached = tryDeltaCacheHit(…); if cached → return cached
                                                          // 'stream' skips it: a hit would skip the fall-through
  locate = order === 'stream' ? locateStream : locateInCore
  found = await locate(ctx, store, id)
       ?? await retryOnceAfterRescan(ctx, store, id, () => locate(ctx, store, id))
  if found === undefined → throw objectNotFound(id)
  return serve(ctx, found, gate)

locateStream(ctx, store, id):                             // odb/streaming.c:istream_source
  firstHeld = undefined                                   // the in-core read's answer, if no arm streams
  for source of store.sources:
    if source !== store.primary: await source.registry.assertLoadable()   // M5b: Tier A fires here
    hit = await source.registry.lookup(id)                // find_pack_entry: midx, then packs
    if hit:
      entry = await readEntryHeaderWithChunk(ctx, hit, …) // read once; serve reuses it
      if isBase(entry.header) && entry.header.size > store.bigFileThreshold
        → return { source, arm: 'pack', hit, entry }      // packfile_read_object_stream accepts
      firstHeld ??= { source, arm: 'pack', hit, entry }   // declined: small, or any delta (M5d, M5f)
    compressed = await looseCompressedBytes(ctx, id, source)
    if compressed → return { source, arm: 'loose', compressed }   // loose stream arm: any type, any size
  return firstHeld                                        // open_istream_incore: first holder

locateInCore(ctx, store, id):                             // R1, ADR-509, unchanged per source
  for source of store.sources:
    if source !== store.primary: await source.registry.assertLoadable()
    loose first (cached probe), then pack lookup → first hit
```

Why `firstHeld` is git's in-core answer: git's in-core read walks sources from the primary, packs
then loose, and returns the first holder. Every source before `firstHeld`'s missed both arms in
the stream pass, and `firstHeld`'s own source missed its loose arm there too (else the loose arm
had answered) — so the in-core read lands on exactly that pack entry, and ADR-509's loose-before-
pack precedence of the in-core read is preserved by construction. Reusing the entry avoids a second
lookup and header read. The retry re-runs `locate` after `store.reprepare()`: git's stream pass
has no retry, its in-core fallback's `SECOND_READ` re-prepares every source; both reach every
source and serve the same bytes, differing only under a concurrent repack.

**Callers — order per git counterpart.**

| tsgit read | git counterpart | order |
|---|---|---|
| `streamBlob` (`stream-blob.ts`) — public, and the regular-file worktree writers: `apply-changeset.ts:258`, `apply-merge-to-worktree.ts:198`, `commands/merge.ts:711`, `commands/stash.ts:413` | `cat-file blob`; `entry.c:streaming_write_entry` | `'stream'` |
| `verifyStoredObject` (`blob-source.ts`, via `ref-target.ts:assertRefTargetValid` ← `update-ref.ts`, `clone.ts`) | `object.c:parse_object_with_flags`: `odb_read_object_info` type probe; blob → stream, else in-core | type probe `readDeclaredObjectHeader`, then `'stream'` for a blob, `'in-core'` otherwise (DC-17) |
| whitespace-drop predicate (`whitespace-drop-predicate.ts:121–122`) | `diff.c:diff_populate_filespec` | `'in-core'` |
| `readBlob` for a symlink or a smudge filter (`apply-changeset.ts:226, 236`) | `entry.c:read_blob_entry`, in-core filter class | unchanged (buffered read, R1) |
| `catFileBatch` blob entries, `show` of a blob, `archive` / `packObjects` above the threshold | stream | DC-18 |

A refused streamed checkout leaves no file in tsgit (the object opens before the output); git leaves an empty one (M5i) — DC-19.

`readDeclaredObjectHeader(ctx, id): Promise<{ type; declaredSize }>` (`read-object.ts`) is
`resolveDeclaredSize` generalised — pack: `readPackedMetadata` (header, delta-base type walk);
loose: the `LOOSE_HEADER_PROBE_BYTES` prefix — per source in R1 order, the same rescan and lazy
fetch; `readDeclaredObjectSize` maps its `declaredSize`. It is git's `odb_read_object_info` with
`typep`. In `verifyStoredObject` the type probe and the open run inside one `withLazyFetchRetry`.

**Pre-existing postures kept (recorded, not widened).** git's loose stream arm *declines* a
loose file whose header does not unpack and moves on; tsgit's loose arm throws (as the primary
does today, ADR-509). git's pack arm marks an `OBJ_BAD` entry bad and declines; tsgit's
`readEntryHeaderWithChunk` throws. Both differ only for a corrupt store.

**Edge — a non-blob id given to `streamBlob`.** `cat-file blob`/`-p` probe the type first
(`builtin/cat-file.c`: `odb_read_object_info`, then `stream_blob` only for `OBJ_BLOB`), so git
never streams a non-blob; checkout streams without a probe (the index says blob). `streamBlob`
serves both and keeps checkout's shape: it streams, then refuses a non-blob
(`unexpectedObjectType`). With a corrupt alternate midx and a small non-blob held by the primary,
both tools refuse, with different error data (git: type error; tsgit: the Tier-A midx error).
Recorded; a type probe per `streamBlob` would tax every checkout write to change only which
refusal is reported.

**Repository without alternates** (one source). Every read answers the same bytes as today; no
later source exists, so no new fault can fire. Differences: (1) an object held **both** loose and
packed, non-delta, above `core.bigFileThreshold` (512 MiB default) is now served from the pack
(git's arm order; today: the loose copy) — a corrupt loose copy of it no longer fails the read, as
in git; (2) `verifyStoredObject` pays one header-only type probe before the open; (3) a
`verifyStoredObject` of a blob no longer consults the delta cache (blobs enter it only as delta
bases).

**Perf.** Without alternates: `streamBlob` does the same calls reordered — the pack lookup now
precedes the cached loose probe (a loose-only object pays a lookup first, as every buffered read,
pack-first, already does); the entry header read that today's pack arm does
anyway is reused by `serve`; an object held both loose and packed pays one extra header read
(rare: gc prunes packed loose copies). `verifyStoredObject`: + one type probe per ref update
(memoised per Context by `ref-target.ts:verifiedTargetType`); for the common fresh loose commit,
a ≤ 1 KiB `readSlice` of a file read moments later. With alternates: a streamed read of an object
the primary holds small or as a delta reaches every alternate — per alternate one memoised
`assertLoadable` (the first reach builds that registry: `readdir(pack/)` + midx load), one
in-memory `lookup`, one cached loose probe (first probe of a fanout prefix: one `readdir`). That
is git's own cost; a checkout of N files in a borrower pays N × alternates in-memory lookups.

### D5 — Enumeration and abbreviation

- `enumerateObjects(ctx, { scope?: 'all' | 'local' })`, default `'all'` (A5, git's
  `odb_for_each_object` without `ODB_FOR_EACH_OBJECT_LOCAL_ONLY`). Loose: each source's 256
  fanout dirs through `source.fs`; packs: each source's `registry.all()`/`health().accessible`.
- `resolveOidPrefix`: `scanLoose`/`scanPacks` per source, union, ambiguity over the union (X2).
  `MAX_OID_PREFIX_CANDIDATES` unchanged.
- Public behaviour change (changelog, not breaking): in a repository with alternates, the public
  `enumerateObjects`, `hasObject`, `resolveOidPrefix` and every reader now see alternate objects.
  Repositories without an alternates file are unaffected.

### D6 — Write path: git's freshen (ADR-922)

`writeObject` (`write-object.ts`) gains one step **after hashing and before deflate**:

```ts
// src/application/primitives/internal/freshen-object.ts  (new; carries the @writes block, §D11)
/** git's `odb_freshen_object`: true when some source holds `id` and the holding file's times
 *  were set to now — the caller then skips the write. */
export async function freshenObject(ctx: Context, id: ObjectId): Promise<boolean>;
```

```
store = await getObjectStore(ctx)
for source of store.sources:                            // primary first, then git's DFS order
  await source.registry.assertLoadable()                // every source reached — W5: Tier A fires
                                                        // here; for the primary this follows
                                                        // from the same source loop (today's
                                                        // writeObject never loads the registry,
                                                        // so a corrupt primary midx now fails a
                                                        // write too)
  hit = await source.registry.lookup(id)                // midx first, then packs — first hit only
  if hit:
    if (await source.registry.fileNames()).has(`${hit.pack.name}.mtimes`) → fall to loose arm
                                                        // cruft: git returns 0, tries no other pack
    else if freshenedPacks.has(hit.pack) → return true  // git's p->freshened, per pack instance
    else if await touch(source, `${packsDirIn(source.objectsDir)}/${hit.pack.name}.pack`)
      freshenedPacks.add(hit.pack); return true
  if await probeLooseOid(ctx, id, source)               // cached fanout listing (ADR-926)
     and await touch(source, looseObjectPathIn(source.objectsDir, id)) → return true
return false

touch(source, path):
  if source.fs.utimeNow === undefined → false           // browser / user fs without it (ADR-925)
  try { await source.fs.utimeNow(path); return true }
  catch (e) { if errorDataCode(e) === undefined → rethrow       // not an adapter refusal
              ctx.logger?.debug?.('objectStore: freshen refused', { path, code }); return false }
```

- `freshenedPacks` is a module-level `WeakSet<RegisteredPack>`: the flag dies with the pack
  instance, exactly git's `packed_git.freshened`.
- A refused `utimeNow` is **git's contract, not a swallowed error**: "freshen failed ⇒ do not
  skip the write" (`object-file.c:75` comment). Any adapter code counts (FILE_NOT_FOUND from a
  race, PERMISSION_DENIED, EROFS-mapped codes); a non-adapter error propagates.
- `false` ⇒ today's local write, unchanged: deflate → `writeExclusive`. `FILE_EXISTS` there (a
  loose file another writer created after the fanout cache was loaded) additionally runs
  `touch(primary, path)` — the freshen git's `access(F_OK)` would have performed — and returns the
  id either way (git's `finalize_object_file` treats `EEXIST` as success).
- **Adapter without `utimeNow` (ADR-925: browser/OPFS, or a user `opts.fs` that omits it).**
  Every `touch` is `false`, so `freshenObject` is `false` for every object and the local write
  runs — git's path when `utime` fails. Object already **loose** in the primary:
  `writeExclusive` reports `FILE_EXISTS`, the `touch` there is `false` too, the id is returned
  and the file is not rewritten. Object held only **packed** (any source): a duplicate loose copy
  is written in the primary — today's browser behaviour, unchanged.
- **Stale loose listing (ADR-926).** The loose arm trusts the cached fanout listing; a loose copy
  another process wrote into an **alternate** after this session listed that fanout dir is
  missed, so a local duplicate is written where git would freshen the donor's copy. Bytes and
  every read answer unchanged. (In the primary the same race ends in `FILE_EXISTS` → `touch`.)
- Behaviour change for **every** repository: an object the primary holds packed is no longer
  duplicated loose (WP2); its `.pack` mtime moves instead. An object held only in a cruft pack is
  still written loose (WP3), as git resurrects it.
- No rescan: git's freshen never re-prepares. The probe does not reuse `hasObject` (it counts
  cruft packs and re-scans on a miss).
- It is the "probe-before-deflate" half of backlog 31.10 (d-ii); that item consumes this.
- `fetch.ts:202` already uses `hasObject(…, 'recheck')` → FE1 holds once `hasObject` is chain-aware.

Symlinked directories inside a store: the Node write guard refuses a path whose ancestor is a
symbolic link resolving outside the root, so an alternate whose `pack/` or fanout dir is a link
leaving its objects dir gets a local copy where git bumps through the link (reads still work —
ADR-625 reads are lexical). Narrow; recorded, not widened.

Permission semantics: git's `utime(fn, NULL)` needs ownership **or** write permission; Node's
`fs.utimes` with explicit times needs ownership. They differ only for a file that is writable
but not owned — git writes every loose object and `.pack` as `0444`, so for git-written stores
both reduce to "owner only" (WP8). Recorded, not an ADR-level divergence.

### D7 — gc / prune

- `owned`: `enumerateObjects(ctx, { includePacks: false, scope: 'local' })` + primary
  `registry.all()` (already primary by D3) — G1/G2.
- The closure walk reads through every source (it must traverse donor commits). The comment in
  `toNormalPackInputs` ("there is no fifth home … false arm unreachable by construction") becomes
  false: an alternate is the fifth home; the `owned.has(id)` guard is now the `-l` behaviour and
  gets its own test.
- `pruneLooseFiles` unlinks only ids from the local `looseSet` (G3).
- `packedAnywhere(ctx, looseSet)` consults **every** source's packs (G4/G5).
- gc's closure is pinned to `'walk'` (`gc-pipeline.ts:60`), as git's `repack` never reads
  bitmaps for its own pack (`pack-objects` disables them when not packing to stdout); the
  per-source bitmap search (§D13) therefore never runs under gc.

### D8 — fsck (ADR-919, ADR-920, ADR-921)

- Universe: `enumerateObjects(ctx, { scope: 'all', includePacks: full, accessiblePacksOnly })`.
- Content validation (`content-validation.ts:378`, `object-cache.ts:274`) reads loose bytes from
  the source that holds the id (needs `looseCompressedBytesIn(source, id)`); hash-mismatch /
  corrupt findings unchanged in shape.
- `runPackHealthPass`, `runRevIndexHealthPass`, `runMidxHealthPass`, `runBitmapHealthPass` loop
  over `store.sources` (git: `repo_for_each_pack` over all sources; midx verify per source;
  `verify_bitmap_files` = every source's midx bitmap, then every source's pack bitmaps).
- Commit-graph: git runs `commit-graph verify --object-dir <source>` per source
  (`builtin/fsck.c:1155`); tsgit's fsck has no commit-graph pass for the primary, so none is
  added for alternates (ADR-921: "to the extent tsgit's fsck verifies that class today").
- A Tier-A midx fault in an alternate rejects the run (M4), as for the primary.
- Store diagnostics are not fsck findings in git (they are stderr preamble); F5's exit 10 comes
  from the missing objects. tsgit surfaces them through the ADR-914 channel.

### D9 — Security (for the security review's sign-off)

- **Read surface added**: for every path named (transitively, ≤ 6 levels) by an
  `info/alternates` inside the repository: `<alt>/info/alternates`, `<alt>/xx/<hex>`,
  `<alt>/pack/` listing, `*.idx|*.pack|*.rev|*.bitmap`, `multi-pack-index`,
  `multi-pack-index.d/*`, `info/commit-graph`, `info/commit-graphs/commit-graph-chain`,
  `info/commit-graphs/graph-<hex>.graph`; plus metadata probes (`lstat`/`readlink`/`stat`) on
  each component of each alternate path for realpath, through `AlternatePathProbe`, which carries
  no content-reading member. No other file shape is ever opened.
- **Threat**: a hostile repository author can point alternates anywhere the process can read.
  Disclosure is limited to files that parse as git objects/packs at object-shaped paths and are
  then served as object content — identical to git (ADR-625 §7.2: read escapes are git's model;
  git cannot both support alternates and refuse outside reads). Loose reads do not verify the
  hash by default — same as git; fsck does.
- **Write surface added outside the repository (ADR-922) — needs the security review's sign-off.**
  Exactly one operation, `utimeNow`, on exactly two path shapes inside an alternate's realpath'd
  objects dir: `<alt>/<2 hex>/<38 hex>` (the loose file of the id being written) and
  `<alt>/pack/pack-<hex>.pack` (the pack the lookup returned for that id). It is issued only
  after that source's own lookup found the id there; it never creates a file, never changes a
  byte of content, and sets atime/mtime to *now* (no caller-chosen time). Enforcement is
  structural, three layers deep: (1) the facade hands an alternate a capability object that
  has no other write member (§D3); (2) that capability's adapter is rooted at the alternate's
  objects dir alone, so its write guard refuses any path outside it — `..` included; (3) the
  adapter's leaf check refuses a symbolic-link leaf (`PERMISSION_DENIED`, as `chmod` does), so a
  planted `xx/<hex>` link cannot redirect the bump outside. Impact if abused by a hostile
  repository author: mtimes of object-shaped files in a directory the process can already write
  move forward — the donor's `gc --prune=<expiry>` then keeps those objects longer, which is
  the purpose of git's freshen. Same exposure as git.
- **Writes inside the primary**: the same `utimeNow` on the primary's loose file / `.pack`
  through `ctx.fs` (guarded by the main adapter, or `wrapFsValidator` for a user fs).
- **DoS**: depth capped at 6 levels, dedupe makes cycles terminate; the list file is read whole
  (git reads it whole, no cap) — a hostile multi-GB list is the same exposure git has.
- **Containment**: alternates do not widen the main adapter's root set or its write guard; each
  alternate's capability is confined to its own objects dir (ADR-915). Windows: `isAbsolutePath` covers drive/UNC forms; `\\?\` long paths pass through the
  Node adapter unchanged.

### D10 — Diagnostics (ADR-914)

Adopted: emitted once per resolution via `ctx.logger?.warn?.('objectStore: unusable
alternate', { reason, path, listedIn })` (house precedent) **and** exposed as data by
`objectSources(ctx)` → `{ sources: [{ objectsDir, local }], unusable: AlternateDiagnostic[] }`.
The view is also the interop oracle for O1 (`count-objects -v` `alternate:` lines).

### D11 — The `utimeNow` port operation (ADR-922, ADR-915)

```ts
// src/ports/file-system.ts — FileSystem, next to `chmod`
/**
 * Set an existing entry's access and modification times to the current time — git's
 * `utime(path, NULL)`. Never creates the entry. Refuses a symbolic-link leaf with
 * PERMISSION_DENIED (no portable no-follow utime exists — the `chmod` posture), a missing
 * entry with FILE_NOT_FOUND, and a path outside the containment roots with PERMISSION_DENIED.
 * OPTIONAL: an adapter that cannot set times omits it (OPFS). A caller that finds it absent
 * treats the times as not set — git's freshen then writes a fresh copy instead.
 */
readonly utimeNow?: (path: string) => Promise<void>;
```

Why this name and shape, not a DC: git's only call is `utime(fn, NULL)` (time = now); no
caller needs a chosen time (YAGNI), and a chosen-time API would let a hostile repository set
arbitrary times through the alternate capability. **Optional**, following `atomicRename`'s
precedent: adding a required member to the public port would break every user-supplied
`FileSystem`.

| adapter | implementation |
|---|---|
| Node (`node-file-system.ts`) | `chmod`'s template (L1543): `resolveWrite(path)` → `assertLeafSafeToWrite(real, path)` → `runFs(() => this.fsOps.utimes(real, now, now), path)` with `now = new Date()`; `FsOperations` (`fs-operations.ts` L24) gains `'utimes'` |
| Memory (`memory-file-system.ts`) | `chmod`'s template (L425): `walk(path, 'no-follow')`; symlink leaf → `permissionDenied`; unoccupied → `fileNotFound`; else the private `touch(normalized)` (L617), which already sets `ctimeMs`/`mtimeMs` to `Date.now()` (a real `utime` moves ctime too) |
| Browser (`browser-file-system.ts`) | **omitted** — OPFS exposes `File.lastModified` read-only; the only way to move it is to rewrite the file (ADR-925) |
| `wrapFsValidator` (`src/repository/wrap-fs-validator.ts`) | `guardedUtimeNow`, modelled on `guardedAtomicRename` (L96–110): forwarded only when present, behind the **write** guard |

Write-surface audit (`tooling/audit-write-surfaces.ts`, ADR-140 grammar): the new module
`src/application/primitives/internal/freshen-object.ts` opens with

```
/**
 * …
 * @writes
 *   surface: objectFreshen
 *   kind:    equivalent-under-readback
 *   format:  utime-now
 */
```

and `test/integration/object-freshen-interop.test.ts` carries `@proves … interopSurface:
objectFreshen` (bucket `cross-tool-interop`). No allowlist entry. `kind`: the freshen writes no
bytes, so `byte-identical` cannot apply; what the interop proves is the readback state — the
local object set equals git's peer (no duplicate copy) and `git fsck` accepts it — plus the set
of files whose mtime moved. `write-object.ts` keeps its own `looseObject` block unchanged.

### D12 — Commit-graph per source (ADR-921, Pin CG)

`internal/read-commit-graph.ts`, `loadGraphUncached` (L203) becomes:

```
if shallow → undefined                                   // commit_graph_compatible, primary-scoped
store = await getObjectStore(ctx)
for source of store.sources:                             // prepare_commit_graph: first graph wins
  graph = await readGraphOne(ctx, store, source)
  if graph → return graph
return undefined

readGraphOne(source):                                    // read_commit_graph_one
  single = tryRead(source.fs, commitGraphPathIn(source.objectsDir))
  if single and decodes → return [layer]                 // decode failure: fall through (CG6)
  return loadChain(ctx, store, source)

loadChain(holder):                                       // load_commit_graph_chain_fd_st
  hashes = chain lines of holder's commit-graph-chain    // absent/empty file → undefined
  layers = []
  for hash of hashes:
    layer = first source s in store.sources whose graph-<hash>.graph exists and decodes
    if none → ctx.logger?.warn?.('commitGraph: unable to find all commit-graph files',
                                  { chain: <holder chain path>, layer: hash }); break
    layers.push(layer)
  return layers.length > 0 ? loadedGraph(layers) : undefined   // the prefix (CG4); empty → next source (CG5)
```

- Each file read goes through the source's own `fs` (`tryRead`/`tryReadUtf8` L129–147 take a
  `SourceLocation['fs']` instead of `ctx`). The `exists`-first gate is kept per probe.
- Decode failures (`isGraphDecodeFailure`, L222) are caught **per file**, not around the whole
  load — the change that makes CG6 (corrupt single ⇒ chain ⇒ next source) fall out.
- Memo (`graphCache`, `absentGraphs`, `headerCache` per session) unchanged; callers unchanged.
- Path helpers (`path-layout.ts` L90–98): `commitGraphPathIn(objectsDir)`,
  `commitGraphChainPathIn(objectsDir)`, `commitGraphLayerPathIn(objectsDir, hash)`; the
  `gitDir` forms delegate (`write-commit-graph.ts:93` keeps writing the primary's single file —
  tsgit writes no split chain, so a borrower's write is git's non-split `--reachable`).
- Behaviour change without alternates: a chain with a missing **non-base** layer now serves its
  prefix (today: absent), and a corrupt single file no longer hides a valid chain. Speed only.
- The warning goes to the logger only (ADR-927); tests assert it through an injected logger.

### D13 — Bitmaps per source (ADR-921, Pin BM)

`internal/closure-engine.ts`, `tryBitmapClosure` (L333):

```
store = await getObjectStore(ctx)
for source of store.sources:                             // open_midx_bitmap: every source's midx
  await source.registry.assertLoadable()                 // BM6: Tier A fires here
  artefact = await loadMidxBitmapArtefact(ctx, await source.registry.midxBitmap())
  if artefact → return closure(artefact)
for source of store.sources:                             // open_pack_bitmap: repo_for_each_pack
  for pack of await source.registry.all():
    artefact = await loadPackBitmapArtefact(ctx, pack)
    if artefact → return closure(artefact)
return undefined                                         // walk
```

The loaders (`midx-bitmap-binding.ts`, `pack-bitmap-binding.ts`) are source-agnostic — the
artefact carries its own pack/midx, so positions resolve against the source that owns them. A
decline keeps today's semantics (the next candidate, then the walk; BM5). Callers (`push.ts`,
`pack-objects.ts`, `rev-list.ts`) are unchanged; gc never reaches this (`'walk'`, §D7). Which
artefact answered is not public data, so BM2–BM4 are unit-pinned; BM1/BM5/BM6 are interop rows
(result set + `tier`, or the refusal).

### Perf statement

- **No alternates file** (the 100 % case today): +1 `fs.read` per session, concurrent with
  `createPackRegistry`'s own config reads (cold path, no serial latency added beyond the
  slower of the two); per object: `peekObjectStore` (one `WeakMap.get`, replacing
  `peekPackRegistry`'s) + a one-element `for…of`. The miss path loops one source. Commit-graph
  and bitmap loading probe exactly what they probe today.
- **The lookup hot path changes shape** (loop wrapper, store indirection, loose-cache re-key) →
  a `bench:ab` row is required: `cat-file`/`readBlob` warm and cold, `log` walk, `status:clean`
  on a no-alternates fixture, gated at the advisory ±envelope; plus an informational row with a
  `--shared` fixture. Run on Node 24 per #312 notes.
- **Streamed open (§D4.1).** No alternates: same calls as today, reordered (pack lookup before
  the cached loose probe), header read reused; `verifyStoredObject` + one header-only type probe
  per ref update. Borrower: a streamed read of a primary small/delta object reaches every
  alternate (memoised `assertLoadable`, in-memory lookup, cached loose probe) — git's cost.
  `bench:ab` rows: `streamBlob` warm/cold (packed small, packed large, loose) and a checkout of a
  tree on the no-alternates fixture; informational borrower checkout row.
- **Config.** `core.bigFileThreshold` is read once per store, inside the registry's existing
  `readConfig` coalescing window — no added stat.
- **Write path (freshen).** Writing a **new** object: per source one memoised `assertLoadable`,
  one `registry.lookup` (fanout binary search per pack/midx, in memory), one cached loose probe —
  the first probe of a fanout prefix in a session costs one `readdir` of that fanout dir per
  source (ADR-926) — then today's deflate + `writeExclusive`. Writing an object that **already
  exists**: one `utimeNow` (for a pack, at most once per pack per session) and **no** deflate,
  no write — cheaper than today, which deflates and fails `writeExclusive` on a loose hit and
  writes a duplicate on a packed hit. New fixed cost: the first `writeObject` of a session now
  builds the primary pack registry (one `readdir(pack/)`) if no read did so before. `bench:ab`
  rows: `add.bench.ts` (new files; re-adding unchanged files) on a no-alternates fixture.
- With alternates: one resolution per session (≤ components × alternates `lstat`s), one registry
  per alternate built lazily on first reach; commit-graph: ≤ 2 `exists` per source until one
  yields a graph, ≤ 1 `exists` per source per chain layer; bitmaps: one `midxBitmap()` per source
  before any pack bitmap.

### Part split (dependency order, TDD-sized)

Each part ends green on `npm run validate`. **Fifteen parts** (Part 6b added by revision #2;
numbering kept stable). Rough total: ~2,100 lines of `src/` added or changed and ~5,500 lines
of tests (unit + property + interop). No single new `src/` module is several hundred lines: the
largest are `object-store.ts` (~260) and `internal/alternate-chain.ts` (~220); the largest new
files are the interop suites (Part 13 ~750, Part 8 ~400), split per surface so none carries
every row. Part 1 depends on nothing; Part 3's `ObjectSourceAccess` type needs Part 2's port
member; Part 6b needs Part 6.

**Part 1 — `parseAlternatesFile` + `unquoteCStyle` (domain)** · src ~150 / tests ~350
- New: `src/domain/storage/alternates.ts` (+ export from `src/domain/storage/index.ts`),
  `test/unit/domain/storage/alternates.test.ts`, `alternates.properties.test.ts`
  (shared generators in that directory's `arbitraries.ts` if present).
- Examples: every Pin P row as literal bytes.
- Properties: lens 3 totality (never throws on arbitrary bytes, numRuns 200); lens 4
  counting (k column-0 non-`#`, non-`"` lines with no NUL ↔ k entries, 100); lens 1 round-trip
  against an independent test-side C-quoter for paths without `\n` (200).
- No I/O, no `node:`.

**Part 2 — `FileSystem.utimeNow` (port + node + memory + validator; browser omits)** · src ~60 / tests ~240
- `src/ports/file-system.ts` `FileSystem` (L50–273): add the optional member of §D11 after
  `chmod` (~L208).
- `src/adapters/node/node-file-system.ts` `NodeFileSystem.utimeNow`, template `chmod` (L1543–1550);
  `src/adapters/node/fs-operations.ts` `FsOperations` Pick (L24) + `'utimes'`.
  `cspell.json` gains `utimes` in this commit (inserted in place — never re-sort the file).
- `src/adapters/memory/memory-file-system.ts` `utimeNow`, template `chmod` (L425–429), body ends
  in the private `touch(normalized)` (L617).
- `src/adapters/browser/browser-file-system.ts`: no member (structural absence).
- `src/repository/wrap-fs-validator.ts`: `guardedUtimeNow` beside `guardedAtomicRename`
  (L96–110), write guard, spread where `guardedAtomicRename` is spread.
- Tests:
  - `test/unit/ports/file-system.contract.ts` (`fileSystemContractTests`, run by the memory and
    node suites): a `utimeNow(fs, p)` helper modelled on `lexists` (L179 — throws when absent);
    add `{ name: 'utimeNow', … }` to `pathCalls` (L48) so the **security matrix** (L1530: `..`
    traversal + sibling directory, ×2 rows per call) covers it; a new block beside the `chmod`
    rows (L1999–2030): regular file → `stat().mtimeMs` advances past a back-dated value;
    directory → resolves; symlink leaf → `PERMISSION_DENIED`; missing → `FILE_NOT_FOUND`. Back-
    dating needs a new optional env hook `createBackdatedFile?: (path) => Promise<void>` on
    `FileSystemContractEnv` (Node: write + `node:fs` `utimes` to 2001; memory: write under
    `vi.setSystemTime(2001)`).
  - `test/unit/ports/file-system.test.ts` (L56 pattern): a double omitting `utimeNow` type-checks.
  - `test/unit/adapters/browser/browser-file-system.test.ts` (L8 pattern): structurally absent.
  - `test/unit/repository/wrap-fs-validator.test.ts`: forwarded when present, absent when absent,
    guard refuses an outside path before delegating.
  - `test/unit/adapters/node/node-file-system-injected.test.ts`: an injected `utimes` rejection
    surfaces with the `runFs`-mapped code and `data.path`.

**Part 3 — per-source `SourceLocation` refactor (behaviour-preserving)** · src ~120 / tests ~60
- `pack-registry.ts`: `createPackRegistry(ctx: Context, location?: SourceLocation)`
  (`SourceLocation` in `internal/source-location.ts`; `ObjectSourceReader`/`ObjectSourceAccess`/
  `AlternatePathProbe` in the new port file `src/ports/object-source-access.ts`); replace the 10 `ctx.fs.` and 3 `packsDir(commonGitDir(ctx))` sites
  (`listPackDir`, `createStoreGate`, `scanPacks`) with `location`.
- `internal/midx-source.ts` `loadMidxSet(ctx, packsDir, listing)` → add `fs` (5 sites);
  `internal/pack-artefact-source.ts` (3), `internal/pack-byte-source.ts` (2).
- `internal/loose-oid-cache.ts`: functions gain an optional `SourceLocation` (absent = primary,
  today's session-keyed map, unchanged); a present location is keyed by object identity (D3);
  `path-layout.ts`: add `looseObjectPathIn(objectsDir, id)`, `packsDirIn(objectsDir)`.
- Gate: the existing suites unchanged and green (no expectation edits); mutation on touched lines.

**Part 4 — chain resolution (`internal/alternate-chain.ts`)** · src ~220 / tests ~450
- `resolveObjectSources(ctx, io: AlternateChainIo)` + realpath walk (ADR-917) over
  `io.probe` + diagnostics (ADR-914, ADR-916) + comparator honouring `core.ignoreCase`.
- Unit tests on the memory adapter (symlinks supported there): Pins R, N, D, U rows; property:
  resolution terminates and yields distinct `objectsDir`s for an arbitrary directed graph of
  alternates (lens 2, 100).

**Part 5 — `ObjectStore` memo + per-alternate capability** · src ~300 / tests ~400
- New `object-store.ts` (`getObjectStore`, `peekObjectStore`, `objectSources`); re-point
  `read-object.ts` `getPackRegistry`/`peekPackRegistry`/`refreshPackRegistry` at
  `store.primary.registry`; `disposePackRegistry` → `store.dispose()`.
- Capability (§D3, ADR-915/916): `src/repository.ts` `RuntimeFallback` (L301, add
  `makeConfinedFs`), the facade beside `worktreeFs` (L595–625: narrowing + per-`objectsDir`
  memo), `src/index.node.ts` (beside `makeWorktreeFs` L175), `src/ports/context.ts` (`Context`
  gains optional `objectSourceAccess` and `alternatePathProbe`, beside `worktreeFs` L328),
  memory/browser entry points (no hook → `ctx.fs` narrowed).
- Tests: the capability object's own keys are exactly the `ObjectSourceAccess` members;
  `openWithNoFollow(_, 'write')` refused; node: `utimeNow` on a path outside the alternate's
  objects dir → `PERMISSION_DENIED`; memo identity per `objectsDir`; memory out-of-root →
  `unreachable`.
- Public export of `objectSources` in `src/application/primitives/index.ts` + `repo.primitives`;
  the browser-surface audit (`tooling/audit-browser-surface.ts`, blocking) needs a
  `repo.primitives.objectSources(` call in a `test/parity/scenarios/*.ts` scenario — add a
  no-alternates scenario here (`{ sources: [primary], unusable: [] }`); Part 14 extends it.
- `bigFileThreshold` (§D3): move `DEFAULT_BIG_FILE_THRESHOLD_BYTES` from
  `commands/internal/fsck/read-configuration.ts` (L22) to a primitives module
  (`internal/big-file-threshold.ts`, with `readBigFileThreshold(ctx)` =
  `readConfig(ctx).core?.bigFileThreshold ?? DEFAULT`); fsck's `readFsckConfiguration` and
  `test/unit/application/commands/internal/fsck/content-validation.test.ts` (L7) import it from
  there (commands → primitives is the allowed direction). Store construction reads it in the
  `Promise.all`. Tests: default when unset; a configured value; not re-read on `refresh()`.

**Part 6 — read paths through the chain (in-core order)** · src ~230 / tests ~400
- `object-resolver.ts`: `resolveObjectContentWithDepth`, `tryResolveViaRegistry` →
  per-source, `readLooseCompressed`/`looseCompressedBytes` take a source.
- `read-object.ts`: `resolveObjectMetadataWithContent`, `resolveDeclaredSize`,
  `readLooseDeclaredSize`, `loosePathFor`.
- `internal/blob-source.ts`: `tryOpenBlobSource` loops sources in today's loose-first arm order
  (this is the `'in-core'` order of Part 6b; no behaviour change for one source).
- `has-object.ts`: `probeOnce`; `internal/retry-after-rescan.ts` + `internal/pack-miss-rescan.ts`:
  take the store, `store.reprepare()`, forget prefix in every source.
- `commands/fetch-missing.ts:objectExistsLocally` (L52–59) → every source.
- Tests: memory-adapter Contexts with a hand-written alternates file; M2/M3 ordering; miss
  retry discovers a pack added to an alternate after first scan.

**Part 6b — streamed blob open in git's stream order (§D4.1, ADR-928)** · src ~170 / tests ~380
(+ ~60 / ~120 for `catFileBatch` and `show` if DC-18 (a); + ~20 / ~40 if DC-19 (b))
- Context to pre-load:
  - `src/application/primitives/internal/blob-source.ts`: `openBlobSource(ctx, id,
    maxBufferedBytes, options?: OpenBlobSourceOptions)` (L96) — `OpenBlobSourceOptions`
    (L84, extends `StreamBlobOptions`, adds `looseMode`) gains a required `order: BlobReadOrder`,
    so the options argument becomes required; `tryDeltaCacheHit` (L135) runs only for
    `'in-core'`; `tryOpenBlobSource` (L153) splits into `locateStream` / `locateInCore`
    returning a `LocatedBlob` (`{ source, arm: 'loose', compressed } | { source, arm: 'pack',
    hit, entry }`) and `serveLocated` (the existing `resolveLoose` L308, `resolvePackBase`,
    `resolvePackDelta` — the latter takes `located.source.registry`); `verifyStoredObject`
    (L214) / `hashStoredObject` (L225): type probe, then the order by type (DC-17).
  - `src/application/primitives/stream-blob.ts` `streamBlob` (L14): passes `{ ...options, order:
    'stream' }`.
  - `src/application/primitives/internal/whitespace-drop-predicate.ts` L121–122: add
    `order: 'in-core'`.
  - `src/application/primitives/read-object.ts`: `resolveDeclaredSize` (L357) →
    `resolveDeclaredHeader` returning `{ type, declaredSize }` (pack: `readPackedMetadata` L503
    already yields `type`; loose: `resolveDeclaredSizeFromPrefix` L443 parses the header — return
    its type too); export `readDeclaredObjectHeader`; `readDeclaredObjectSize` (L352) maps it.
  - `object-resolver.ts`: `readEntryHeaderWithChunk` (L1032), `isBase` (L1009) — reused, not
    changed. `ObjectStore.bigFileThreshold` (Part 5).
  - Keep today's `checkAborted(ctx)` before each arm, now per source.
  - DC-18 (a): `src/application/primitives/cat-file-batch.ts` `readOne` (L37,
    `readObjectWithSize`) and `src/application/commands/show.ts` (L125/L163,
    `readObjectStreamed`); tests `test/unit/application/primitives/cat-file-batch.test.ts` and the
    show suite.
- Unit (`test/unit/application/primitives/internal/blob-source.test.ts`, memory Contexts; an
  alternate whose registry `assertLoadable` rejects stands in for the corrupt midx), one isolated
  test per exit of `locateStream`: primary pack arm accepts (non-delta, size > threshold — the
  alternate is never reached: spy); size == threshold declines → reaches the alternate (rejects);
  delta above threshold declines → reaches it; primary loose arm serves (alternate not reached);
  both loose and packed large non-delta → pack served; declined everywhere, no later holder →
  `firstHeld` served with **no second header read** (spy on `readEntryHeaderWithChunk`); full miss
  → rescan → hit in an alternate; `'stream'` skips a delta-cache entry, `'in-core'` uses it;
  `'in-core'` never reaches the alternate for a primary-held object. `stream-blob.test.ts`:
  passes `'stream'`. `whitespace-drop-predicate.test.ts`: passes `'in-core'`.
  `read-object-metadata.test.ts`: `readDeclaredObjectHeader` type for loose / packed base /
  packed delta; `readDeclaredObjectSize` unchanged.
  `ref-target.test.ts`: a blob target reaches the rejecting alternate; a commit target does not.
- Regression: `test/integration/blob-streaming-interop.test.ts` and
  `blob-streaming-checkout-interop.test.ts` stay green unedited (one-source behaviour).
- Mutation focus: the strict `>` against the threshold, the `isBase` conjunct, the
  `firstHeld ??=` (first holder, not last), the `source !== store.primary` gate, the order switch
  in `verifyStoredObject`.
- Bench: `pack-read.bench.ts` / `loose-read.bench.ts` `streamBlob` rows and `checkout.bench.ts`
  (§Perf).

**Part 7 — enumeration and abbreviation** · src ~100 / tests ~200
- `enumerate-objects.ts` (`scope`), `resolve-oid-prefix.ts` (`scanLoose`, `scanPacks` per source).

**Part 8 — freshen in `writeObject` + its interop** · src ~130 / tests ~350 + interop ~400
- `src/application/primitives/write-object.ts` `writeObject` (L26–60): after the post-hash abort
  check (L37) and before `readConfig`/deflate, `if (await freshenObject(ctx, computed)) return
  computed;`; the `FILE_EXISTS` arm (L50–55) also runs the primary `touch` (§D6).
- New `src/application/primitives/internal/freshen-object.ts` (`freshenObject`, `touch`,
  `freshenedPacks`) with the `@writes` block of §D11.
- Helpers: `getObjectStore` (Part 5); `PackRegistry.lookup`/`fileNames`/`assertLoadable`
  (`pack-registry.ts` interface ~L253–275); `probeLooseOid(ctx, id, location)` (Part 3);
  `looseObjectPathIn`/`packsDirIn` (Part 3); `errorDataCode` (`src/domain/error-data-code.ts`).
- Unit (`test/unit/application/primitives/write-object.test.ts` + new
  `internal/freshen-object.test.ts`, memory adapter, `vi.setSystemTime`): one isolated test per
  exit — primary loose hit (mtime advanced, no write); primary pack hit (`.pack` advanced,
  `.idx`/`.rev` not, no loose file); cruft-only (written; cruft files untouched); same pack twice
  in a session (one `utimeNow` — spy); `utimeNow` refused (written); `utimeNow` absent (written;
  ADR-925) and absent with the object already loose in the primary (`FILE_EXISTS`, id returned,
  file not rewritten); a loose copy added to an alternate after its fanout listing was cached
  (local copy written — ADR-926);
  alternate loose / alternate pack hit; refusal in the primary then alternate hit (WP4); a
  non-adapter error propagates; `FILE_EXISTS` → `touch` called; Tier-A midx in an alternate
  rejects the write (W5). Any existing write-object row asserting a loose file for an
  already-packed object changes — justified by WP2.
- Interop `test/integration/object-freshen-interop.test.ts` (`interopSurface: objectFreshen`):
  peer pair, same operation on both tools, assert identical local object sets
  (`cat-file --batch-all-objects --batch-check` on the primary only), identical set of files
  whose mtime moved past a fence, and `git fsck` clean. Portable rows: W1, W2, W2m, W4, W5,
  WP1, WP2, WP3, WP7, WP8, FE1. Rows needing an immutable file (W2b, W3, WP2b, WP4, WP5, WP6) use
  `chflags uchg` and run `skipIf(process.platform !== 'darwin')` — Linux needs root for
  `chattr +i`; their logic is covered portably by the unit rows above.
- Bench: `test/bench/add.bench.ts` rows per §Perf.

**Part 9 — commit-graph per source** · src ~120 / tests ~300 + interop ~250
- `src/application/primitives/internal/read-commit-graph.ts`: `tryRead`/`tryReadUtf8`
  (L129–147) take an `fs`; `loadChain(ctx, gitDir)` (L161) → `loadChain(ctx, store, holder)`;
  `loadGraphUncached` (L203) loops sources; `isGraphDecodeFailure` (L222) applied per file.
- `path-layout.ts` (L90–98): the three `…In(objectsDir)` helpers of §D12.
- Unit (`test/unit/application/primitives/internal/read-commit-graph.test.ts`): CG1–CG6 shapes
  on memory Contexts. The row at L442–444 ("a chain whose most-recent layer file has been
  deleted … Then the WHOLE graph is treated as absent") **flips** to "the base layer is served"
  — expectation change justified by CG4; add a corrupt-single-with-valid-chain row (CG6, primary
  only) and a logger-warn row.
- Interop `test/integration/alternates-acceleration-interop.test.ts`, CG1–CG6: git's verdict
  from the deleted-object trick; tsgit's oracle is `commitHeader(ctx, oid)` (graph-sourced header
  defined ⇔ git succeeded) — `rev-list` success alone is not proof, as tsgit may still read the
  commit object.

**Part 10 — bitmaps per source** · src ~50 / tests ~250 + interop ~150
- `src/application/primitives/internal/closure-engine.ts` `tryBitmapClosure` (L333–350) per §D13.
- Unit (`test/unit/application/primitives/internal/closure-engine.test.ts`, loader spies):
  BM2 (primary pack before donor pack), BM3 (donor midx before primary pack), BM4 (primary midx
  before donor midx), BM5 (corrupt donor bitmap → next / walk), BM6 (corrupt donor midx → throws).
- Interop rows BM1, BM5, BM6 in `alternates-acceleration-interop.test.ts` via
  `revList({ useBitmapIndex: true })`: result set equal to git's, `tier: 'bitmap'` for BM1.

**Part 11 — gc / prune** · src ~60 / tests ~200
- `commands/internal/gc-pipeline.ts` L852 (`scope: 'local'`), `toNormalPackInputs` guard test,
  `packedAnywhere` across sources, `pruneLooseFiles` unchanged input.

**Part 12 — fsck** · src ~200 / tests ~400
- `commands/fsck.ts` L90 universe; `internal/fsck/{object-cache,content-validation,object-presence,
  pack-health,rev-index-health,midx-health,bitmap-health,refs-verify}.ts` per source (bitmap
  order per `verify_bitmap_files`); finding attribution per ADR-920 (`internal/fsck/types.ts`
  pack-class variants L60–93); `docs/design/fsck.md` L238/L500/L666 per ADR-919.

**Part 13 — lookup interop** · interop ~750
- New `test/integration/alternates-interop.test.ts` using `interop-helpers.ts`
  (`runGit`, `git`, `makePeerPair`, `disableAutoMaintenance`, `tryRunGitWithExit`),
  `pack-fixture-helpers.ts` (`flipEntryBodyByte`, `writeLooseObject`, `readSolePackPair`),
  `midx-fixture-helpers.ts` (`writeMultiPackIndex`, `mutateMidxOrThrow`).
  Remember: build the tsgit Context **after** the git subprocess writes (per-Context loose
  fanout cache).
- Rows: A1–A5, P1–P14 (via `objectSources().sources` vs `count-objects -v`), R1–R8, N1–N4,
  D1–D4, O1, U1–U3 (+U4/U5 as read outcomes), M1–M4, M5a–M5m, X1–X3.
- M5 rows — fixture of Pin M5 (git builds it; assert the precondition with `verify-pack -v`:
  `delt` non-delta, `base` a delta, no borrower loose object — pack-objects picks the delta
  direction). The threshold rows set `core.bigFileThreshold` in the borrower's **config file**
  (`git config`), never `-c`: tsgit reads only the repository's local config, and both tools must
  see the same value. "Refusal" = git exit 128 with the M3 fatal ⇔ tsgit rejects with the same
  Tier-A midx error data as row M3.

  | row | git (exit) | tsgit oracle |
  |---|---|---|
  | M5a | `cat-file -t B` 0, `rev-parse HEAD:f` 0, `cat-file --batch-check` 0 | `readObjectMetadata(B).type === 'blob'`; `hasObject(B)`; `HEAD:f` resolves to B |
  | M5b | `cat-file blob B` 128 | `streamBlob(B)` refusal |
  | M5c / M5d | threshold 5 → 0 / 6 → 128 | `streamBlob(B)` bytes `small\n` / refusal |
  | M5e / M5f | threshold 1: `delt` 0 / `base` 128 | `streamBlob(delt)` bytes / `streamBlob(base)` refusal |
  | M5g / M5h | `update-ref refs/tags/tb B` 128 / `… tc HEAD` 0 | `updateRef` to B refusal, ref absent / to HEAD succeeds |
  | M5i | `checkout -- f` 128 | `checkout({ paths: ['f'] })` refusal; worktree residue per DC-19 |
  | M5j | `checkout -- lnk` 0 | `checkout({ paths: ['lnk'] })` restores the link |
  | M5k | `diff --stat -w HEAD~1 HEAD` 0 | `diff` with `ignoreWhitespace: 'all'` succeeds, same changed paths |
  | M5l | B also loose (copied in with `writeLooseObject`): `cat-file blob B` 0, `checkout -- f` 0 | `streamBlob(B)` bytes; checkout restores `f` |
  | M5m | `archive HEAD` 0 | `archive` succeeds |

  `cat-file --batch` (B) and `show B` (M5b) join the table per DC-18.

**Part 14 — gc/fsck interop, parity, bench, docs** · interop ~350 / other ~200
- `test/integration/alternates-gc-fsck-interop.test.ts`: G1–G5, F1–F5.
- `test/parity/scenarios/`: extend Part 5's scenario — one cross-adapter row (memory + node)
  with an in-root alternate; one memory row for an out-of-root alternate (ADR-916).
- `test/bench/`: the `bench:ab` rows of §Perf (`cat-file`, `log`, `status`, `add`).

## Decisions

### Ratified (ADR-914 … ADR-928)

| DC | ADR | outcome |
|---|---|---|
| DC-1 | ADR-914 | unusable alternates: `logger.warn` + structured `objectSources(ctx)` view; never throw |
| DC-2 | ADR-915 | one capability per alternate, confined to its objects dir: confined reader + confined `utimeNow`; metadata-only probe for the realpath walk (user-ratified) |
| DC-3 | ADR-916 | an adapter-refused alternate is skipped as `unreachable`; OPFS resolves absolute paths in its sandbox |
| DC-4 | ADR-917 | realpath emulated through the port (`lstat`+`readlink` walk, missing leaf tolerated) |
| DC-5 | ADR-918 | explicit `ObjectSource`/`SourceLocation`; `ObjectStore` memo; `getPackRegistry` stays primary |
| DC-6, DC-7 | ADR-919 | fsck audits every source; supersedes ADR-412's alternates bullet |
| DC-8 | ADR-920 | pack-class fsck findings carry an optional `objectsDir` |
| DC-9 | ADR-921 | **every acceleration file per source, exactly as git** (user-ratified; deviates from the draft's recommendation) — §D12, §D13 |
| DC-10 | ADR-922 | **full git freshen on write, primary included** (user-ratified; deviates from the draft's recommendation) — §D6, §D11 |
| DC-11 | ADR-923 | `GIT_ALTERNATE_OBJECT_DIRECTORIES` unsupported |
| DC-12 | ADR-924 | chain resolved lazily, once per session; `refresh()` re-reads add-only (user-ratified) |
| DC-13 | ADR-925 | browser/OPFS omits `utimeNow`; every freshen there fails and the local write runs; an already-loose object is found present by the exclusive write (§D6, §D11) |
| DC-14 | ADR-926 | the freshen's loose arm consults the cached fanout listing and calls `utimeNow` only on a hit; a stale listing yields a harmless local duplicate (§D6) |
| DC-15 | ADR-927 | commit-graph missing-layer warning → `logger.warn` only, no structured surface (§D12) |
| DC-16 | ADR-928 | **streamed blob open follows git's per-source stream order, fall-through and refusal included** (user-ratified; deviates from the draft's recommendation) — §D4.1, Pin M5 |

### New decision candidates (uncovered by revision #2)

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| DC-17 | How `verifyStoredObject` picks its order (git's `parse_object`: blob → stream, else in-core) | (a) git's literal sequence: header-only type probe `readDeclaredObjectHeader` (git's `odb_read_object_info`), then `openBlobSource` in `'stream'` order for a blob, `'in-core'` otherwise; (b) fused: one `locateStream` pass that, at the first holder, reads the type from the entry header (a delta: walks to its base type) and switches to in-core serving for a non-blob — no separate probe | **(a)** | both reproduce M5g/M5h; (a) is git's own call sequence (same fault order: type probe faults before stream faults), reuses `resolveDeclaredSize`'s routes, and costs one header-only probe per ref update — memoised per Context, typically a ≤ 1 KiB read of a just-written loose commit. (b) saves that probe but puts a type-dependent branch inside `locateStream`, the hottest new code, for a once-per-ref-update caller |
| DC-18 | Scope of the stream order beyond `openBlobSource`'s callers — git also streams `cat-file --batch` blob contents and `show <blob>` (M5b: both die), and, above the threshold only, `archive` / `pack-objects` blobs. tsgit's `catFileBatch` (`readObjectWithSize`), `show` (`readObjectStreamed`), `archive` (`readBlob`) and `packObjects` read in-core | (a) fold `catFileBatch` and `show` in now, in git's sequence: type first through `readDeclaredObjectHeader` (git's `--batch` info read / `show`'s object lookup), a blob's content then through `openBlobSource(…, { order: 'stream' })` (`catFileBatch` honouring `maxBytes`), any other type through today's read; record `archive`/`packObjects` (they differ only for a blob above 512 MiB that the primary holds as a delta or not at all) in this doc; (b) none now: record all four as a fault-surface divergence in an ADR and open a follow-up backlog item; (c) all four now | **(a)** | ADR-928's intent is that the same corrupt-alternate faults refuse the same reads, and `cat-file --batch`/`show` are the direct analogues of M5b — same mechanism, ~60 src / ~120 test lines in Part 6b; cost without alternates: one header-only type probe per `catFileBatch` entry / `show` (a cached pack window, or a ≤ 1 KiB loose read) and no blob read twice. (c) re-plumbs `archive`/`packObjects` for a case git itself avoids (blobs above the threshold are never deltified by `pack-objects`). (b) leaves the most visible M5b analogue divergent |
| DC-19 | Worktree residue of a refused streamed checkout (M5i: git leaves `f` as an **empty file** — `streaming_write_entry` opens the output before the stream and `die` skips its unlink) | (a) keep tsgit's order (open the object, then the file): the refusal leaves `f` absent; record the divergence; (b) reproduce: every streamed worktree writer creates/truncates the output before opening the blob, and leaves it on a refusal | **(a)** | the residue is an artefact of `die()` after `open()`, not a state git designs (a non-fatal stream failure unlinks the file, `entry.c:streaming_write_entry`); (b) changes every streamed checkout's failure state — a missing object would then need git's unlink-then-in-core-retry dance too — to reproduce a crash leftover. Divergence needs its ADR (prime directive) |

## Test strategy

- **Domain** (Part 1): example rows = Pin P literal bytes; property sibling (lenses 1, 3, 4).
- **Port** (Part 2): the shared contract `test/unit/ports/file-system.contract.ts` runs `utimeNow`
  through the security matrix and its own refusal rows on memory and node; browser asserts
  structural absence; `wrapFsValidator` forwards it behind the write guard.
- **Resolution** (Part 4): memory-adapter unit tests per Pin R/N/D/U row; lens-2 property on
  arbitrary alternate graphs — invariants only, no re-implemented traversal as oracle:
  terminates; `objectsDir`s distinct; every node reachable within six levels appears; every
  source appears after the source whose list named it first (pre-order); depth ≤ 5.
- **Store / capability / read paths** (Parts 5–7): memory-adapter Contexts; isolated guard tests
  for each source-loop exit (hit in primary pack, primary loose, alternate pack, alternate loose,
  full miss → rescan hit in an alternate pack); M2/M3 ordering test; `peekObjectStore` gating;
  capability narrowing (exact member set, write-mode open refused, out-of-dir `utimeNow` refused).
- **Streamed open** (Part 6b): one isolated test per `locateStream` exit (§Part 6b list) with an
  alternate whose `assertLoadable` rejects as the reach detector; threshold boundary (`==`
  declines, `>` accepts); delta above threshold declines; `'in-core'` callers never reach it;
  `verifyStoredObject` blob vs commit.
- **Freshen** (Part 8): one isolated test per exit of `freshenObject` (§Part 8 list) with
  `vi.setSystemTime` back-dating; mutation targets: the cruft check, the `freshenedPacks` memo,
  the absent-`utimeNow` arm, the adapter-code vs rethrow split.
- **Acceleration** (Parts 9–10): commit-graph CG1–CG6 shapes and the flipped missing-layer row;
  bitmap order BM2–BM6 with loader spies.
- **gc / fsck** (Parts 11–12): unit rows mirroring G1–G5 and F1–F5/M4 with a memory store.
- **Interop**: four files, one per surface — `alternates-interop.test.ts` (Part 13),
  `object-freshen-interop.test.ts` (Part 8, `interopSurface: objectFreshen`),
  `alternates-acceleration-interop.test.ts` (Parts 9–10), `alternates-gc-fsck-interop.test.ts`
  (Part 14). Reconstruct X1 from `ambiguousOidPrefix` data and O1 from `objectSources()`; fsck rows
  compare structured findings + exit bits to git's (ADR-249). Immutable-file rows are darwin-only
  (`chflags uchg`).
- **Parity**: memory vs node for an in-root alternate; memory out-of-root → `unreachable`.
- **Mutation**: Stryker low mode, narrowed corpus per module (`.claude/workflow/mutation.md`).
- **Perf**: `bench:ab` rows per §Perf.

## Out of scope

- `GIT_ALTERNATE_OBJECT_DIRECTORIES` — ADR-923.
- `objects/info/http-alternates`, dumb HTTP — fenced.
- Producing borrowers: `clone --reference/--shared/--dissociate` options — fenced.
- `repack -a -d` dissociation; a `local` option on tsgit's `packObjects` (git's default includes
  borrowed objects, which tsgit's default already matches) — fenced / not needed.
- Submodule alternates set-up — fenced; a submodule Context reads its own repository's
  alternates file naturally (fresh session).
- Alternate refs as negotiation `.have`s (`core.alternateRefsCommand`, `for_each_alternate_ref`)
  — fetch negotiation optimisation; FE1's "already have" holds without it.
- A rendered `count-objects` command — not needed; `objectSources()` carries the data.
- Commit-graph **verification** in fsck — tsgit's fsck has no commit-graph pass for the primary;
  ADR-921 scopes fsck coverage to the classes tsgit verifies today.
- Commit-graph **writing** as a split chain on top of an alternate's layers (CG3's write half) —
  tsgit writes single-file graphs only; unchanged.
- Observed, not changed here (discuss before scheduling): tsgit's chain-file grammar
  (`parseChainLayerHashes` trims and drops blank lines) differs from git's fixed-width read
  (`invalid commit-graph chain: line '…' not a hash`, `commit-graph chain file too small`).
