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
> blob reads, §D4.1, Pin M5 widened) → DC-17 … DC-19 ratified (ADR-929 … ADR-931) →
> **revision #3** (scope folded: every git streaming reader — `cat-file --batch`, `show`,
> `archive`, `pack-objects` — §D4.2; git's worktree residue of a refused streamed write and
> the every-source gate where git refuses before writing, §D4.3/§D4.4; Pin M5 widened with
> M5n … M5ac) → DC-20 ratified (ADR-932) → **revision #4** (scope folded: `archive` honours
> `export-ignore` and `export-subst`, ADR-933, §D14/§D15; `merge` writes `ORIG_HEAD` where git
> does, §D16; the delta search skips objects above `core.bigFileThreshold`, §D17; Pins E, S, OH,
> BT) → self-reviewed ×3 → 2 new decision candidates (§Decisions, DC-21, DC-22).
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

<!-- cspell:ignore chflags uchg utimes chattr incore delt typep readlen unloadable mtrunc ltrunc noexport valueonly keyonly unfold GNUPG gpgsm qqqq MUSTBEDIR mailmapped Creset Cgreen Cblue GOODSIG BADSIG EXPSIG EXPKEYSIG REVKEYSIG ERRSIG untranscoded strwidth reencode memmem -->

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
| ADR-914 … ADR-933 | this feature's ratified decisions — mapping in §Decisions |
| ADR-415 / ADR-416 / ADR-418 | `archive` emits a structured entry stream (`ArchiveEntry.content` = the bytes git writes); serializers are pure and take only rendering inputs — export-subst output is entry **content**, not a rendering input (ADR-933) |
| ADR-765 | `archive` refuses what `git archive` refuses — extended by the two `export-subst` refusals (`%(count)`, `%(total)`, Pin S) |
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
- **R14** `archive` omits every entry whose `export-ignore` attribute is **set** (`ATTR_TRUE`;
  `export-ignore=true` is a string value and does not count), resolved from the **archived
  tree's** `.gitattributes` plus `info/attributes` and `core.attributesFile` — never the
  worktree's — in bare and non-bare repositories alike; a directory is checked as `<path>/`
  (directory-only patterns match it) and an ignored directory drops its whole subtree; a
  directory entry is emitted only once a non-directory descendant reaches the export-ignore
  check, so an empty subtree, or a directory whose children are all ignored directories, is not
  emitted (ADR-933, Pin E, §D14).
- **R15** For a regular-file entry whose `export-subst` attribute is set, when the tree-ish
  peels to a commit, `archive` emits git's `format_subst` expansion of the blob: every
  `$Format:<fmt>$` replaced by `repo_format_commit_message(<fmt>)` under archive's context
  (`DATE_NORMAL`, `DEFAULT_ABBREV`, colour never, one `%(describe)` per archive, no rev, no
  reflog, no notes), byte-for-byte on every row of Pin S; `%(count)` / `%(total)` refuse as git
  dies; such an entry is never streamed (ADR-930's `!export-subst` conjunct) (ADR-933, §D15).
- **R16** Attribute patterns ending in `/` match directories only (`attr.c:path_matches`,
  `PATTERN_FLAG_MUSTBEDIR`) for every attribute caller — today `resolveAttribute` ignores
  `AttributeRule.directoryOnly`, so `foo/ text` wrongly applies to a file `foo` (Pin E9, §D14).
- **R17** `merge` writes `ORIG_HEAD` = the pre-merge HEAD once the merge base is computed and
  before any outcome — up-to-date, fast-forward, `--no-ff`, clean, conflict, the ff-only
  refusal, the would-overwrite refusal — with no reflog (`builtin/merge.c:1633`, Pin OH, §D16).
- **R18** The pack builder's delta search neither deltifies nor offers as a base any object
  whose size is strictly above `core.bigFileThreshold` (`builtin/pack-objects.c:2626`
  `no_try_delta` → `should_attempt_deltas`; Pin BT, §D17).

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
  archive and pack-objects for blobs above the threshold only (exact conditions below). `diff`
  reads in-core (`diff.c:diff_populate_filespec`).
- `cat-file --batch` (`builtin/cat-file.c:print_object_or_die`): the info read
  (`odb_read_object_info_extended`, in-core order) prints `<oid> <type> <size>`, **then** a blob's
  contents stream; any other type reads in-core. M5n: the header line reaches stdout before the
  fatal.
- `show <blob>` (`builtin/log.c:show_blob_object` → `stream_blob_to_fd`, no textconv by default);
  `show <tag>` reaches its blob target the same way.
- `archive` (`archive.c:write_archive_entry`): streams iff `S_ISREG(mode) && !export-subst &&
  odb_read_object_info(…) == OBJ_BLOB && size > bigFileThreshold` (`size` = the object's size, a
  delta's result size), then `archive-tar.c:stream_blocked` / `archive-zip.c:write_zip_entry` open
  the stream (`odb_read_stream_open`; a NULL stream is `error("cannot stream blob")`). Every other
  entry reads in-core (`object_file_to_archive`). The pack arm then accepts every non-delta entry
  (its header size equals the object size, already `> threshold`), so archive refuses only for a
  blob the primary holds **as a delta** above the threshold (M5q).
- `pack-objects` (`builtin/pack-objects.c:write_no_reuse_object`): streams a blob iff it is not
  reused from a pack, has no usable delta, and `oe_size > bigFileThreshold`. **But** before any of
  that, `cmd_pack_objects` → `pack-objects.c:prepare_packing_data` → `prepare_in_pack_by_idx` →
  `repo_for_each_pack` prepares **every source's pack store** — so pack-objects in a borrower with a
  Tier-A alternate dies at start-up, for any input, the empty one included (M5u–M5w). The stream
  order inside pack-objects is unobservable through an alternate fault; only its copy choice
  remains (§D4.2).
- Checkout (`entry.c:write_entry`): a regular file whose conversion is streamable
  (`get_stream_filter_ca` non-NULL) goes through `streaming_write_entry`: `open_output_fd` →
  `create_file` (`O_WRONLY|O_CREAT|O_EXCL`, mode `0777` if the entry is executable else `0666`, less
  umask) **before** `odb_stream_blob_to_fd`. A non-fatal failure (no stream: object missing; a short
  read; a non-blob) unlinks the file and falls through to the in-core write. A `die` inside the
  open (the Tier-A midx load) exits with the file created and empty — the M5i residue. The caller
  (`unpack-trees.c:check_updates`) has already run the removals and writes entries one at a time in
  index order, so the residue is: every earlier entry written, the refused one empty, every later
  one untouched; the index lock is rolled back (index, HEAD and refs unchanged).
- **Earlier refusals.** Some writers never reach the streamed write under this fault, because an
  oid **abbreviation** (Pin X: every source's packs) runs first: `merge` prints `Updating a..b`
  (`builtin/merge.c:1663`, after writing `ORIG_HEAD` at L1633); `cherry-pick`/`revert`/`rebase`
  label the pick (`sequencer.c:short_commit_name`); `checkout`/`switch` away from a **detached** HEAD
  abbreviate the old commit (`builtin/checkout.c:switch_branches`, `strbuf_add_unique_abbrev`) before
  `merge_working_tree`. They die with the worktree untouched (M5aa–M5ac).

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
| M5i | `rm f; checkout -- f` | fatal; **`f` left as an empty file** (the output is opened before the stream; `die` skips the unlink), no `index.lock` — widened in M5x … M5ad |
| M5j | `rm lnk; checkout -- lnk` | exit 0 — a symlink is read in-core |
| M5k | `diff --stat -w HEAD~1 HEAD` | exit 0 — diff reads in-core. (`diff` with a patch or `--raw` dies, through the every-source oid **abbreviation** scan of Pin X, not through a read — tsgit renders no abbreviation, ADR-249) |
| M5l | B **also loose** in the primary (file copied in; `hash-object -w` would freshen the pack instead, WP2) | `cat-file blob B`, `checkout -- f` exit 0 — the primary's loose arm streams it |
| M5m | `archive HEAD` | exit 0 — archive streams only blobs above the threshold |

Revision #3 rows. Same fixture plus: `a` (`aaa\n`, 4 bytes) whose **loose** file is kept in the
primary after the repack (copied aside after `git add`, restored after `repack -ad`), `x`
(`exe\n`, mode 100755), a stash entry adding `s` (`stashed\n`, packed by the repack), and a branch
`side` at C1 (the donor's commit, no borrower files). `verify-pack -v`: `a` 4, `delt` 13 890,
`base` 17-byte delta (depth 1, base `delt`), `f` 6, `x` 4, `s` 8 — all packed; only `a` also loose.
umask 022. Scripts: scratchpad `alt-probe-m5{d,e,f,g,i,j,k}.sh` (`.out` beside each).

| # | command in `b` | git |
|---|---|---|
| M5n | `cat-file --batch` (B) | fatal; `<B> blob 6\n` (48 bytes) already on stdout |
| M5o | `-c core.bigFileThreshold=5 cat-file --batch` (B) | exit 0 — the primary's pack arm streams it |
| M5p | `show B`; `show HEAD:f` | fatal, nothing on stdout |
| M5q | `-c core.bigFileThreshold=1 archive HEAD`; same `--format=zip`; same with pathspec `base` (tar and zip) | fatal (the `base` delta declines the pack arm) |
| M5r | `-c core.bigFileThreshold=1 archive HEAD a f x lnk`; `… archive HEAD delt` | exit 0 — non-delta entries stream from the primary's pack arm; `a` likewise (its pack copy is non-delta, served before its loose copy); `lnk` reads in-core |
| M5s | `-c core.bigFileThreshold=5 archive HEAD f`; `=6 … f` | exit 0 / exit 0 (`size 6 > 5` streams and is accepted; `6 > 6` false reads in-core) |
| M5t | `archive HEAD` (threshold default) | exit 0 (= M5m) |
| M5u | `pack-objects --stdout` with stdin: empty; B; `base`; `delt`; `delt`+`base`; `--revs` HEAD; each with and without `-c core.bigFileThreshold=1`, `--no-reuse-object`, `--no-reuse-delta`, `--local` | fatal, 0 bytes out, every variant — `prepare_in_pack_by_idx` prepares every source at start-up |
| M5v | `bundle create x.bundle HEAD` | exit 1, the same fatal (its `pack-objects` child) |
| M5w | `repack -ad`; `gc` | exit 128, the same fatal |
| M5x | `rm f; checkout -- f`; `rm f; checkout HEAD -- f`; `rm f; restore f` | fatal; `f` empty, `0644`; index entry unchanged; no `index.lock` |
| M5y | `rm x; checkout -- x` (100755) | fatal; `x` empty, **`0755`** |
| M5z | `rm a f; checkout -- a f`; `echo modified > f; checkout -- f` | fatal; `a` restored (4 bytes, loose arm), `f` empty / the modified `f` **replaced** by an empty file |
| M5aa | on `side` (attached) at C1: `checkout main`; `switch main`; `checkout -f main`; `reset --hard main` | fatal; `a` written (4 bytes), `base` empty `0644`, `delt` `f` `lnk` `x` absent; HEAD → `side`, `side` at C1, index = C1's, no `index.lock` |
| M5ab | at `main`, clean index: `stash apply` | fatal; `s` empty `0644`; HEAD, index unchanged |
| M5ac | on `side` at C1: `merge --ff-only main`; `merge --no-ff main`; `cherry-pick main`; `revert HEAD` (on `main`); `rebase main` | fatal **before any worktree write**; `merge` has written `ORIG_HEAD` (= C1), the others no state file; HEAD, refs, index, worktree untouched |
| M5ad | **detached** at C1: `checkout main`; `switch main`; `checkout -f main`; `merge --ff-only main`; `cherry-pick main` | fatal before any worktree write (the old-commit abbreviation); `reset --hard main` detached = M5aa |
| M5ae | `push <bare r> :refs/heads/x` (delete-only) | exit 128 with the fatal, **after** the remote deleted `x` — `send_pack` runs no `pack-objects` without a non-delete command (`send-pack.c:672,745`, `need_pack_data`); the fatal comes later, client-side |
| M5af | `push <bare r> side:refs/heads/y` | fatal; `y` not created on the remote (its `pack-objects` died at start-up) |

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

Outside `archive`'s `export-subst` content (§D15, `abbreviateObjectId`) tsgit renders no
abbreviation (ADR-249); the interop test reconstructs X1 from `resolveOidPrefix`'s ambiguity
data.

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

#### Pin E — `export-ignore` (`archive.c:write_archive_entry`, `queue_or_write_archive_entry`)

Fixture root `.gitattributes`: `t1 export-ignore`, `t2 -export-ignore`, `t3 export-ignore=true`,
`t4 !export-ignore`, `[attr]noexport export-ignore` + `t5 noexport`, `a export-ignore`,
`b/ export-ignore`, `c/** export-ignore`, `d/e export-ignore` (`d` holds only `e/`),
`lnk export-ignore` (symlink); `sub/.gitattributes`: `y export-ignore`. Baseline
`git archive HEAD | tar -t` = `.gitattributes c/ g/ g/x keep sub/ sub/.gitattributes sub/x t2 t3 t4`.

| # | case | git |
|---|---|---|
| E1 | `t1` set | omitted |
| E2 | `t2` unset, `t3` = string `true`, `t4` unspecified | kept — only `ATTR_TRUE` counts (`check_attr_export_ignore`) |
| E3 | macro `noexport` | `t5` omitted |
| E4 / E5 | `a export-ignore` / `b/ export-ignore` on directories | `a/`, `b/` and every descendant omitted — the directory is checked as `a/` (trailing slash) before descent |
| E6 | `c/** export-ignore` | `c/` emitted, `c/x` omitted — the queued directory is flushed (`write_directory`) **before** its child's export-ignore check |
| E7 | `d/e export-ignore`, `d` holds only `e` | neither `d/` nor anything below — `d/` stays queued, no non-directory descendant ever flushes it |
| E8 | symlink `lnk` | omitted (attributes checked for every non-directory) |
| E9 | `foo/ export-ignore`; file `foo`, dir `x/foo/` (the only child of `x`) | `foo` kept, `x/` and `x/foo/k` omitted; `check-attr export-ignore foo x/foo x/foo/` → `unspecified`, `unspecified`, `set` |
| E10 | tree holding an empty subtree `empty` (`git mktree`) + `keep` | `keep` only — an empty subtree is never emitted |
| E11 | `archive HEAD:sub` | `.gitattributes x` — `sub/.gitattributes` is the root attributes file of the archived tree; the repository root's rules are invisible |
| E12 | `archive HEAD t1`, `archive HEAD a` | exit 0, empty archive (the pathspec check ignores attributes) |
| E13 | worktree `.gitattributes` edited, uncommitted (`keep export-ignore` added; `t1` rule deleted) | default: unchanged from the committed tree (`keep` kept, `t1` omitted); `--worktree-attributes`: `keep` omitted, `t1` kept |
| E14 | `.git/info/attributes` = `g/x export-ignore` | `g/x` omitted, `g/` emitted |
| E15 | `git clone --bare`, `archive HEAD` | baseline listing — tree attributes apply in a bare repository |
| E16 | `archive <tree-id>` | baseline listing |
| E17 | `s/.gitattributes` committed as a **symlink** to a file holding `q export-ignore` | `s/q` kept — a non-regular `.gitattributes` entry is not read |

Mechanism (`archive.c:parse_treeish_arg`): without `--worktree-attributes`, git `unpack_trees`
the archived tree into a scratch index and calls `git_attr_set_direction(GIT_ATTR_INDEX)`;
`attr.c:read_attr` then reads every in-tree `.gitattributes` from that index only, bare or not,
ignoring `attr.tree`. `info/attributes`, `core.attributesFile` and the system file stay in the
stack as for any lookup.

#### Pin S — `export-subst` (`archive.c:format_subst` → `pretty.c:repo_format_commit_message`)

Archive context (`archive.c:write_archive` L757–770): `date_mode = DATE_NORMAL`,
`abbrev = DEFAULT_ABBREV` (`core.abbrev`, auto when unset), `describe_status.max_invocations = 1`,
colour zero (never), no `rev`, no `reflog_info`, no `notes_message`, no `output_encoding`.
Fixture: parent `d948d40…` tagged `v1` (annotated); HEAD `38096f7…` (tree `f3d80e1…`), author
`A U Thor <author@example.com> 1700000200 +0545`, committer `… 1700000300 +0000`, message
`msg subject line\n\nbody para\n\nSigned-off-by: X <x@y>\n`, branch `main` attached, TZ=UTC.
Each row is `<placeholder>=[$Format:<placeholder>$]` in one file; output between brackets.

| placeholder | output | placeholder | output |
|---|---|---|---|
| `%H` | `38096f729e6651b8bb39ff91bf665623356a0e2c` | `%h` | `38096f7` |
| `%T` / `%t` | `f3d80e15d4…` / `f3d80e1` | `%P` / `%p` | `d948d406d8…` / `d948d40` |
| `%an %ae %al` | `A U Thor`, `author@example.com`, `author` | `%aN %aE %aL` | mailmapped (S12) — unmapped here |
| `%ad` | `Wed Nov 15 04:01:40 2023 +0545` | `%aD` | `Wed, 15 Nov 2023 04:01:40 +0545` |
| `%at` | `1700000200` | `%ai` | `2023-11-15 04:01:40 +0545` |
| `%aI` | `2023-11-15T04:01:40+05:45` | `%as` / `%ah` | `2023-11-15` / `Nov 15 2023` |
| `%ar` | `2 years, 11 months ago` (now-relative) | `%cd` | `Tue Nov 14 22:18:20 2023 +0000` |
| `%cD` | `Tue, 14 Nov 2023 22:18:20 +0000` | `%cI` | `2023-11-14T22:18:20Z` (`Z` for `+0000`) |
| `%s` / `%f` | `msg subject line` / `msg-subject-line` | `%e` | empty (no `encoding` header) |
| `%b` | `body para\n\nSigned-off-by: X <x@y>\n` | `%B` | the whole message |
| `%d` / `%D` | ` (HEAD -> main)` / `HEAD -> main` | `%(decorate:prefix=[,suffix=])` | `[HEAD -> main]` |
| `%(describe)` | `v1-1-g38096f7` | `%(describe:abbrev=4)` (own fixture) | `v1-1-g6c4c` |
| `%n` / `%%` / `%x41` | LF / `%` / `A` | `%x00` | one NUL byte |
| `%m` | `>` | `%G?` / `%GT` | `N` / `undefined` (unsigned) |
| `%GG %GS %GK %GF %GP %gd %gs %gn` | empty | `%Cred %C(red) %C(auto) %Creset %C(never,red)` | empty |
| `%C(always,red)X` | `ESC[31mX` | `%<(8)%an\|` / `%<(3,trunc)%an\|` | `A U Thor\|` / `A..\|` |
| `%>(8)%an\|` / `%><(9)%an\|` | `A U Thor\|` / `A U Thor \|` | `%w(10,2,4)%s` | `  msg\n    subject\n    line` |
| `%+s` / `%-s` | `\nmsg subject line` / `msg subject line` | `x\n%-b` with empty body | `x` (preceding LFs deleted) |
| `% s` / `% b` (empty) | ` subj` / empty | `%(trailers)` / `%(trailers:only)` | `Signed-off-by: X <x@y>\n` |
| `%(trailers:key=Signed-off-by,valueonly)` | `X <x@y>\n` | `%<\|(12)%h` past column 12 | `6c4cdb6` (no pad) |

| # | case | git |
|---|---|---|
| S1 | terminator | the first `$` **after** `$Format:`, anywhere later in the blob, newlines included: `unterminated $Format:%H\n$Format:$ empty` → `unterminated 38096f…\nFormat:$ empty` |
| S2 | no later `$` | the `$Format:…` tail is kept verbatim (`tail $Format:%H` at EOF) |
| S3 | NUL inside a format | the format is a C string: `$Format:%h\0%H$` → `b31a617` (everything from the NUL to the `$` dropped) |
| S4 | binary blob (holds NUL) with `export-subst` | expanded — no binary test |
| S5 | symlink with `export-subst` | not expanded (`object_file_to_archive`: `S_ISREG` only) |
| S6 | regular file above `core.bigFileThreshold` (1000; file 2 KB) with `export-subst` | expanded — the streaming condition excludes `convert` entries |
| S7 | tree-ish is a **tree id** | no expansion anywhere (`args->commit` is NULL); a tag tree-ish peels to its commit |
| S8 | `%(describe)` budget | one per archive, consumed by the first occurrence in archive order (tree pre-order, then left to right) **even when describe yields nothing** (no tags → empty); every later `%(describe…)`, whatever its args, is emitted literally (`a.txt` → `A=`, `z.txt` → `Z=%(describe)`) |
| S9 | `%(count)` / `%(total)` | `fatal: %(count) is not supported by this command` / `… %(total) …`, exit 128, no archive |
| S10 | declined placeholders | `%` + the rest literal: `%S`, `%N` (notes present or not), `%q`, `%Zz`, `%xZZ`, `%Gx`, `%(unknown)`, `%+w(5)`; `%+N` → `N` (the magic byte is consumed, the placeholder declined) |
| S11 | `%(describe:tags)` after the budget is spent | `%(describe:tags)` literal |
| S12 | mailmap source | the **worktree** `.mailmap` (committed `Mapped Name <mapped@example.com> A U Thor <author@example.com>` → `Mapped Name\|mapped@example.com\|mapped`; an uncommitted edit wins; worktree file deleted → unmapped); bare → `HEAD:.mailmap` (`mailmap.blob` default) |
| S13 | decorations | the repository's refs at archive time, not the archived tree's: attached `HEAD -> main, tag: lt2, refs/stash, o/main, side, refs/custom/x`; detached `HEAD, tag: lt2, refs/stash, o/main, side, main, refs/custom/x`; no `log.excludeDecoration` (filter NULL in `get_name_decoration`) |
| S14 | signed commit, `gpg.program` missing | `%G?\|%GG\|%GS\|%GT` = `N\|\|\|undefined`; stderr `fatal: cannot exec …`; the archive is still produced |
| S15 | signed commit, verifier prints no `GOODSIG` | `N`; `%GG` = the verifier's stderr |
| S16 | commit with `encoding ISO-8859-1`, subject `caf\xe9 subj` | `%e` = `ISO-8859-1`; `%s` = bytes `caf\351 subj` (round-trip through UTF-8 back to the commit encoding) |
| S16b | same commit encoding; file `pre-é [$Format:%h$] mid-é [$Format:%h$]` (UTF-8 `é`) | unchanged bytes — `%h` never parses the header, so no `commit_encoding`, no transcoding |
| S16c | same; file `pre-é only\n[$Format:%e$]\n` | `pre-\351 only\n[ISO-8859-1]\n` — a header-parsing placeholder makes `repo_format_commit_message` transcode the **whole buffer so far** (file prefix + earlier expansions) UTF-8 → commit encoding; the tail after the `$` is appended untranscoded |
| S16d | commit `encoding UTF-16`, same file | `\376\377\0p\0r\0e\0-\0\351\0 …\0[\0U\0T\0F\0-\01\06]\n` — BOM + UTF-16 for the prefix and the expansion, `]\n` raw |
| S17 | committer date 2 h ago, author 25 h ago | `%ar` = `25 hours ago`, `%ah` = `Wed Sep 30 20:38` (now-relative modes) |

#### Pin OH — `merge` and `ORIG_HEAD` (`builtin/merge.c` L1633)

| # | case | exit | `ORIG_HEAD` |
|---|---|---|---|
| OH1 | clean true merge | 0 | pre-merge HEAD |
| OH2 | already up to date | 0 | written = HEAD |
| OH3 | fast-forward | 0 | pre-merge HEAD |
| OH4 | `--no-ff` | 0 | pre-merge HEAD |
| OH5 | `--squash` | 0 | pre-merge HEAD (tsgit has no `--squash`) |
| OH6 | conflict | 1 | pre-merge HEAD |
| OH7 | `--ff-only`, not fast-forwardable | 128 | written = HEAD |
| OH8 | untracked file would be overwritten | 1 | written = HEAD |
| OH9 | unrelated histories | 128 | written = HEAD |
| OH10 | unresolvable argument | 1 | not written |
| OH11 | `--ref-format=reftable` | 0 | in the reftable, no `.git/ORIG_HEAD` file |

Content `<oid>\n` (41 bytes); no `logs/ORIG_HEAD` in any row.

#### Pin BT — delta search and `core.bigFileThreshold` (`builtin/pack-objects.c` L2626, `should_attempt_deltas`)

Two similar blobs, 13 898 and 13 893 bytes; `pack-objects --revs --no-reuse-delta --no-reuse-object`.

| threshold | 13 898-byte blob | 13 893-byte blob |
|---|---|---|
| default (512 MiB) | whole | delta |
| 13 898 (= larger size) | whole | delta — strict `>` |
| 13 897 | whole | **whole** — the larger is excluded as a base too, the smaller has no candidate |
| `repack -adf`, 100 | whole | whole |

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
bytes). Windows absoluteness is the primitive's job (`git-path-syntax.ts`,
`src/application/primitives/internal/`) — the domain stays path-syntax-free.

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

Path syntax follows the git build the filesystem belongs to (`internal/git-path-syntax.ts`,
selected by `Context.windowsPathSyntax`, which the Node entry point sets from its native path
policy). POSIX: `/` is the only separator and only a leading `/` is absolute — a `\` or `C:` is
part of a name. Windows (`compat/win32/path-utils.c`): `/` and `\` both separate
(git's cross-platform `is_dir_sep`); `is_absolute_path` is a leading separator or a drive prefix
(`win32_has_dos_drive_prefix`: any ASCII byte or a non-ASCII run of at most four UTF-8 bytes,
then `:`); the root is `win32_offset_1st_component` — a drive (`C:`, `C:\`), a UNC share
(`\\server\share\`), or a single separator — and `get_root_part` converts its `\` to `/`, so
every resolved path is in forward-slash form (`C:\x\objects` → `C:/x/objects`, `C:x` →
`C:/x`). A share-less UNC (`\\server`) has no root, so git's realpath starts it from its cwd — the
work tree's top (git changes into it during setup), else the directory it was started in — and
tsgit does the same with `layout.workDir ?? ctx.cwd`; a symlink whose target is rootless stays
`unresolvable`.

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
| `streamBlob` (`stream-blob.ts`) — public | `cat-file blob` | `'stream'` |
| the regular-file worktree writers `apply-changeset.ts:258`, `apply-merge-to-worktree.ts:198`, `commands/merge.ts:711`, `commands/stash.ts:413` — through `writeStreamedBlob` (§D4.3) | `entry.c:streaming_write_entry` | `'stream'`, split locate / serve |
| `verifyStoredObject` (`blob-source.ts`, via `ref-target.ts:assertRefTargetValid` ← `update-ref.ts`, `clone.ts`) | `object.c:parse_object_with_flags`: `odb_read_object_info` type probe; blob → stream, else in-core | type probe `readDeclaredObjectHeader`, then `'stream'` for a blob, `'in-core'` otherwise (ADR-929) |
| whitespace-drop predicate (`whitespace-drop-predicate.ts:121–122`) | `diff.c:diff_populate_filespec` | `'in-core'` |
| `readBlob` for a symlink or a smudge filter (`apply-changeset.ts:226, 236`) | `entry.c:read_blob_entry`, in-core filter class | unchanged (buffered read, R1) |
| `catFileBatch` blob contents, `show` of a blob (direct or a tag's target) | `print_object_or_die`; `show_blob_object` | type first, then `'stream'` for a blob (ADR-930, §D4.2) |
| `archive` regular-file entries above the threshold; `buildPack` blob contents above the threshold | `write_archive_entry`; `write_no_reuse_object` | `'stream'` under git's condition (ADR-930, §D4.2) |

A refused streamed worktree write leaves git's empty file (ADR-931, §D4.3).

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

`openBlobSource` exposes its two halves to the worktree writers (§D4.3) as internal exports of
`blob-source.ts`: `locateBlob(ctx, id, { order })` → `Promise<LocatedBlob | undefined>` (the gate,
the `locate` pass and its rescan; `undefined` = absent everywhere) and `serveLocatedBlob(ctx,
located, maxBufferedBytes, options)` → `BlobSource`. `openBlobSource` becomes their composition
(`undefined` → `objectNotFound`), so every other caller is unchanged.

### D4.2 — Every git streaming reader (ADR-930, Pin M5n … M5w)

One internal helper serves the three readers that need bytes in hand:
`readBlobContentInStreamOrder(ctx, id)` → `Promise<Uint8Array>`, in `internal/blob-source.ts` —
`openBlobSource(ctx, id, <today's default buffering budget>, { order: 'stream', looseMode:
'streamed' })`, its `bytes` arm returned as is, its `stream` arm drained into one buffer (the `'streamed'` loose posture keeps today's
"a size-lying blob serves its real bytes" rule of `readObjectWithSize`/`readObjectStreamed`).

| reader | today | new | git |
|---|---|---|---|
| `catFileBatch` `readOne` (`cat-file-batch.ts` L37) | `readObjectWithSize` (in-core order) | `readDeclaredObjectHeader(ctx, id)` → missing ⇒ `{ ok: false, reason: 'missing' }` as today; `maxBytes` < `declaredSize` ⇒ today's `objectTooLarge` refusal (no git analogue: a tsgit memory bound, now checked before the open); type `blob` ⇒ `readBlobContentInStreamOrder`, entry `{ ok: true, id, type: 'blob', size: declaredSize, object }` with the blob object shape `readObjectWithSize` returns today; any other type ⇒ `readObjectWithSize` as today | M5n/M5o |
| `show` (`show.ts` `buildForRev` L125, `buildTag` L163 — both `readObjectStreamed`) | `readObjectStreamed` | new `readShowTarget(ctx, id)`: `readDeclaredObjectHeader` → `blob` ⇒ `readBlobContentInStreamOrder` → `{ kind: 'blob', id, content }`; else `readObjectStreamed` as today | M5p |
| `archive` `buildEntryStream` (`archive.ts` L104–118) | `readBlob` for every non-directory entry | regular mode (`100644`/`100755`) **without `export-subst`** (§D15): `readDeclaredObjectHeader` → `blob` and `declaredSize > store.bigFileThreshold` ⇒ `readBlobContentInStreamOrder`; otherwise (symlink, small, non-blob, `export-subst`) `readBlob` as today | M5q … M5t, S6 |
| `buildPack` (`build-pack.ts`) | `buildBaseEntries` `readObject`; deltify `readObjectMetadataWithContent` + emission `readRawObject` (`deltify.ts` L128, L428) | (1) **gate first**: `assertEverySourceLoadable(ctx)` (§D4.4) before any read — M5u–M5w; (2) a blob whose metadata `uncompressedSize > store.bigFileThreshold` and whose content is not already carried takes `readBlobContentInStreamOrder` at the emission read (L428) and in `buildBaseEntries`, which switches from `readObject` to the deltify path's `readObjectMetadataWithContent` + content read (same encoded entry: `{ type, uncompressedSize, compressedData }`) | M5u–M5w; `write_no_reuse_object` |

`archive` keeps its lazy `AsyncIterable` shape: a refusal rejects the iteration **at the refused
entry**, after every earlier entry was yielded — git's tar/zip writer likewise died after
emitting the earlier members (M5q: zip had 62 bytes out; tar's 0 bytes is its 10 KiB block
buffering, a serialiser artefact ADR-249 leaves to the caller). The `!export-subst` conjunct of
git's condition is the attribute itself (`args->convert`), resolved from the archived tree
(§D14, ADR-933) — a tree-id archive, which expands nothing, still reads such a file in-core.

`buildPack` (2) is what ADR-930 adopts; the pins show its **observable** effect is narrower than
the ADR's context assumed. Once (1) has prepared every source, the stream order can no longer
reach a source the in-core order would not; it changes only *which copy* serves a large blob
(the source's non-delta pack copy before its loose copy) — visible only for a corrupt copy. git
copies a reused pack entry without reading it at all; tsgit always re-encodes
(`docs/design/delta-writing-packer.md`, "always re-encodes from inflated content"), so tsgit's
read set is git's `--no-reuse-object` read set and the condition is "blob above the threshold"
with no reuse term. The metadata pass reads a loose object's content before (2) can route it
(corrupt-store edge, recorded with the postures of §D4.1).

### D4.3 — The refused streamed worktree write (ADR-931, Pin M5i, M5x … M5ab)

All four regular-file writers call one new helper in `internal/write-working-tree-file.ts`,
replacing their `streamBlob` + `write*Stream` pairs:

```
writeStreamedBlob(ctx, fullPath, id, mode?):              // entry.c:streaming_write_entry
  await rmIfExists(ctx, fullPath)                          // check_updates/unlink_entry before the write
  let located
  try { located = await locateBlob(ctx, id, { order: 'stream' }) }
  catch (refusal) {                                        // git: die inside odb_read_stream_open
    if (isOperationAborted(refusal)) throw refusal         // a cancellation: no git counterpart, no residue
    await createEmptyOutput(ctx, fullPath, mode)           // git: create_file ran first; die skips unlink
    throw refusal
  }
  if (located === undefined) throw objectNotFound(id)      // git: NULL stream → unlink → in-core read fails: no file
  try {
    await ctx.fs.writeStream(fullPath, sourceChunks(await serveLocatedBlob(ctx, located, …)))
    if (mode !== undefined) await ctx.fs.chmod(fullPath, permFor(mode))
  } catch (failure) {                                      // git: readlen < 0 / non-blob → unlink(path)
    await rmIfExists(ctx, fullPath)
    throw failure
  }
```

This is ADR-932, *create on refusal*: the empty file appears after the locate refuses rather
than before it (git creates it first), with git's end state and git's first error in every
single-fault case, at no cost on the success path. `createEmptyOutput` = `ctx.fs.write(fullPath, EMPTY)` then, when `mode` is given, `chmod` to
`0o755`/`0o644` (git's `create_file` mode less umask: M5y `0755`, M5x `0644`). A writer called
without a mode (`merge.ts`, `apply-merge-to-worktree.ts`, `stash.ts`) leaves the adapter default,
as its successful write does today. If `createEmptyOutput` itself fails, its error is thrown with
the refusal as `cause` (git's first error there is the create failure). An `operationAborted`
from the locate's per-arm `checkAborted` is rethrown **without** creating the file: a caller's
cancellation has no git counterpart (the occupant, already unlinked, stays removed — as for any
abort after `rmIfExists` today). The non-blob refusal
(`unexpectedObjectType`) now happens in the serve arm and unlinks, as git's `st->type != OBJ_BLOB`
does.

**Index-order residue under a concurrent wave.** `applyChangeset`'s write wave
(`applyWriteWave` → `drainPooled`, ioBound pool) writes concurrently; git writes one entry at a
time in index order (`check_updates`), so its residue is exact: earlier entries written, the
refused one empty, later ones untouched (M5aa). A concurrent wave would leave an arbitrary subset.
tsgit reproduces git's residue without taxing healthy repositories:

```
applyWriteWave(...):
  if (await everySourceLoadable(ctx))   → today's concurrent wave           // the only refusal locate can raise
                                                                           // after this is a corrupt-store one
  else                                  → the same wave, concurrency 1, changeset order
```

`everySourceLoadable(ctx)` (`object-store.ts`, §D4.4) settles every source's memoised
`assertLoadable` without throwing and answers whether all resolved. With one source it is the
primary's already-settled memo. A borrower settles every alternate's registry here instead of at
its first reach — no observable difference (no write, no warning). The sequential fallback runs
only in a store with an unloadable source, where git itself is sequential. The sequential
fallback writes in git's index order: `splitWaves` (L308) preserves the changeset's order, and
the fallback sorts the writes with `compareEntryPath` (git's index order, as `materialize-tree.ts`
L184 does) rather than assume the changeset arrives sorted; Part 6d asserts the M5aa residue
against git's. Removals run in the delete wave before, as in git.

Pre-existing, recorded, not widened: corrupt-store refusals raised mid-wave (a corrupt entry
header, a loose header that does not parse) keep the concurrent wave's arbitrary residue; git's
in-core retry after its unlink may also serve another copy where tsgit refuses (§D4.1 postures).

### D4.4 — The every-source gate where git refuses before writing (Pin M5u–M5w, M5ac … M5af)

`object-store.ts` gains two functions over `store.sources`:

- `assertEverySourceLoadable(ctx): Promise<void>` — `await source.registry.assertLoadable()` for
  every source, primary first; the first rejection propagates (the M3 Tier-A error data).
- `everySourceLoadable(ctx): Promise<boolean>` — the same, settled (§D4.3).

`assertEverySourceLoadable` reproduces the refusal point of git's every-source reach where that
reach precedes a write. tsgit computes no display abbreviation (ADR-249), so it calls the gate
where git abbreviates (the one abbreviation tsgit does compute — `export-subst` content, §D15 —
reaches every source itself, as git's does):

| tsgit call site | git reach | pin |
|---|---|---|
| `buildPack` entry (`build-pack.ts`, before `resolveWriterPlan`) — covers `packObjects`, `bundleCreate`, `gc`, and `push` when it needs pack data | `prepare_in_pack_by_idx` at pack-objects start-up | M5u–M5w, M5af |
| `mergeRun` (`merge.ts` L148), after the `ORIG_HEAD` write (§D16) and before every other worktree or state write | `Updating a..b` / merge abbreviation (`builtin/merge.c:1663`) | M5ac |
| `cherryPickRun` / `revertRun` / `rebaseRun` and their `…Continue` / `…Skip`, at each pick before its first write | `sequencer.c:short_commit_name` | M5ac |
| `checkout` (`checkout.ts` L336) switching branches **from a detached HEAD**, before the worktree update | `switch_branches`: `strbuf_add_unique_abbrev` of the old commit | M5ad |

`push` builds a pack only when git's `send_pack` would run `pack-objects`: some non-delete
command (`need_pack_data`). Today `push.ts` (L334–341) calls `buildPack` unconditionally and
sends an empty pack for a delete-only push; it now sends none, as git (`send-pack.c:745`) — so a
delete-only push from a borrower with an unloadable alternate updates the remote, as git's does
(M5ae; git's later client-side fatal is exit status only, the M5k precedent).

`git merge` writes `ORIG_HEAD` (L1633) before the abbreviation; §D16 moves tsgit's write to
the same point (it was conflict-path only), and the `mergeRun` gate runs after it — under this
fault both tools leave `ORIG_HEAD` = old HEAD.

Not gated (git reaches the streamed write first, M5x … M5ab): `checkout` with paths, `restore`,
branch switch from an attached HEAD, `reset --hard`, `stash apply`. Abbreviations git prints
**after** its writes (`commit`'s summary, `reset`'s `HEAD is now at`) change only git's exit
status, never on-disk state — the M5k precedent (ADR-249): tsgit succeeds, recorded.

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

### D8.1 — verify_pack parity

Pinned against git 2.55.0 (scrubbed `GIT_*`, isolated `HOME`, signing off, `gc` with
`gc.writeCommitGraph=false`), each row on a plain repository **and** on a `--shared`
borrower whose donor carries the corruption — identical exit bits; the borrower's lines
name the donor pack by absolute path, the plain repository's by `.git/objects/pack/…`.

Source: `builtin/fsck.c` `cmd_fsck` (L1076–1099: `verify_pack` for every pack of
`repo_for_each_pack`, only when `check_full` and not `connectivity_only`; any non-zero
return sets `ERROR_PACK` = 4), `pack-check.c` `verify_pack` → `verify_pack_index` (`.idx`
trailer) → `verify_packfile` (pack trailer, then per entry in offset order: CRC against
the `.idx` table, `unpack_entry`, `check_object_signature`, then `fsck_obj_buffer`),
`packfile.c` `open_packed_git_1` (L676–678, the open gate), `odb.c`
`odb_read_object_info_extended` (L606–613, the die on a `has_packed_and_bad` object).

| # | corruption | `fsck` | `--no-full` | `--connectivity-only` |
|---|---|---|---|---|
| V1 | pack trailer flipped (F4b) | `packfile P does not match index` ×N, `packfile P cannot be accessed`, `invalid sha1 pointer` per ref, `missing blob …` — **14** (2\|4\|8); a commit-graph on disk adds 16 (**30**: the `commit-graph verify` child, a class tsgit's fsck does not verify) | 10 | 10 (`dangling unknown …`) |
| V2 | `.idx` trailer flipped | `Packfile index for P hash mismatch` — **4** | baseline | 0 |
| V3 | one CRC in the `.idx` flipped, `.idx` trailer restamped | `index CRC mismatch for object O from P at offset N` — **4** | baseline | 0 |
| V4 | body of an unreachable entry flipped, in its own pack (F4c) | `P pack checksum mismatch`, `index CRC mismatch for object O …`, `inflate: …`, `cannot unpack O from P at offset N` — **4**; O is not reported dangling | baseline | 0, `dangling blob O` |
| V5 | body of the ref-tip commit flipped (F4) | `fatal: packed object O (stored in P) is corrupt` — **128** (`snapshot_ref` → `parse_object`) | 128 | 128 |
| V6 | body of a tree the index cache-tree names flipped | V4's lines, then the same fatal — **128** (`fsck_index` cache-tree → `parse_object`) | 128 | 128 |
| V7 | body of a non-tip commit flipped | V4's lines + `invalid reflog entry` — **6**; that commit's tree is `dangling` | baseline | 128 |
| V8 | body of a tree no ref/cache-tree names flipped | V4's lines — **4** | baseline | 128 |
| V9 | body of a reachable blob flipped | V4's lines — **4** | baseline | 0 |
| V10 | packed tree with duplicate entries (intact pack) | `error in tree O: duplicateEntries: …` — **4**, not 1: `fsck_objects_error_func` sets no bit, `verify_pack`'s non-zero return sets `ERROR_PACK` | baseline | 0 |

"baseline": git 2.55's `--no-full` on any packed repository prints `invalid reflog entry`
for packed reflog oids and exits 2 with no corruption at all — never a `verify_pack` line.
`pack checksum does not match its index` is unreachable once the open gate passed (both
compare the same bytes).

tsgit mapping:

- Open gate (`pack-registry.ts` header memo): the pack trailer must equal the `.idx`'s
  recorded pack checksum, else `INVALID_PACK_HEADER` — the pack is unusable for every read
  (git's read path refuses it too) and fsck's pack-health pass reports `pack-inaccessible`
  (V1).
- A new pass over every source's accessible packs, full mode only: the `.idx` trailer
  (`pack-index-checksum-mismatch`, V2); one sequential read per pack hashing it and
  CRC-checking each entry (`pack-checksum-mismatch`, `pack-crc-mismatch`, V3/V4). Bit 4.
- Content validation, packed arm: an unreadable entry is `pack-entry-unpackable` (V4) and a
  hash disagreement `pack-entry-corrupt`, both bit 4 and catalogue-free; a packed object's
  catalogue errors carry bit 4, not 1 (V10). Unpacking rides the existing per-object read —
  no extra inflate.
- Refusal (V5/V6; V7/V8 under `connectivityOnly`): a ref tip or cache-tree oid whose only
  copy is an unreadable pack entry rejects with `INVALID_PACK_ENTRY` (offset, and a reason
  naming oid and pack); under `connectivityOnly` also every reachable commit or tree.

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
  alternate's capability is confined to its own objects dir (ADR-915). Windows: `git-path-syntax.ts` covers drive/UNC forms; `\\?\` long paths pass through the
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

### D14 — `archive` attributes and `export-ignore` (ADR-933, Pin E)

**Attribute source = the archived tree.** `internal/read-gitattributes.ts` splits today's
`buildAttributeProvider(ctx)` into a source-agnostic core and two directory readers:

```
buildAttributeProviderFrom(ctx, readDirAttributes): AttributeProvider   // info → dirs deepest-first → global; macros: info + root + global
buildAttributeProvider(ctx)            = …From(ctx, worktreeDirReader)  // today's behaviour, unchanged
buildTreeAttributeProvider(ctx, tree)  = …From(ctx, treeDirReader(tree))
treeDirReader(tree)(dir):                                   // git: GIT_ATTR_INDEX over the unpacked tree
  entry = await findTreeEntry(ctx, tree, join(dir, '.gitattributes'))   // internal/resolve-tree-path.ts L66
  if entry?.mode not regular (100644/100755) → undefined                 // E17: a symlinked .gitattributes is not read
  → parseGitattributes(decode(readBlob(entry.id)))  — same cap as the worktree reader (MAX_GITATTRIBUTES_BYTES)
```

The tree reader ignores `ctx.layout.workDir` (E15: bare repositories read tree attributes) and
`dirEscapesWorktree` (tree paths are validated by the walk). `info/attributes` and
`core.attributesFile` are read as today (E14). No `--worktree-attributes` option is added
(Follow-ups).

**Directory-only patterns (R16).** `resolveAttribute(sources, path, name, macros)` keeps its
signature and adopts git's calling convention: a path ending in `/` is a directory
(`git_check_attr` on `"<dir>/"`). `resolveInSource` matches `rel` without the trailing slash
and skips a rule whose `directoryOnly` is set unless the path is a directory (E9). Every
existing caller passes file paths, so the change for them is exactly git's: `foo/ attr` stops
applying to a file `foo`.

**The entry stream.** `archive.ts` `buildEntryStream` becomes git's
`queue_or_write_archive_entry` + `write_archive_entry`:

```
buildEntryStream(ctx, tree, subst):
  attrs = await buildTreeAttributeProvider(ctx, tree)
  queued: ArchiveEntry[] = []                      // c->bottom, root-most first
  for await (e of walkTree(ctx, tree, { maxEntries: MAX_SAFE_INTEGER })):
    validateIndexPath(e.path, …)                    // every walked entry, ignored subtrees included (git unpacks the whole tree)
    if (insideIgnored(e.path)) continue
    queued = queued.filter(isAncestorOf(e.path))   // git pops non-ancestors
    if (e.mode is DIRECTORY):
      if (isSet(attrs, `${e.path}/`, 'export-ignore')) { markIgnored(e.path); continue }   // E4, E5, E9
      queued.push(dirEntry(e)); continue
    yield* drain(queued)                            // write_directory: flushed BEFORE the child's check (E6)
    const key = e.mode === GITLINK ? `${e.path}/` : e.path   // git appends '/' to a gitlink before the check
    if (isSet(attrs, key, 'export-ignore')) continue          // E1, E3, E8
    yield await entryFor(e, isSet(attrs, key, 'export-subst'), subst)    // §D15 / §D4.2
```

`isSet` = `resolveAttribute(…) === true` — `ATTR_TRUE` only (E2). A queued directory that no
non-directory descendant flushes is never yielded (E7, E10). `ArchiveResult` and
`ArchiveEntry` keep their shape; `entries` stays lazy.

Recorded, not widened: tsgit's `archive` takes no pathspec (E12 needs none); a missing or
invalid tree object inside an ignored subtree refuses at the walk, mid-stream — git refuses at
`unpack_trees`, before any output (the lazy-stream posture of F7, pre-existing for every walk
failure).

### D15 — `export-subst`: git's user-format expander (ADR-933, Pin S)

**Where it runs.** `entryFor` (§D14) for a regular file (`100644`/`100755`, S5) with
`export-subst` set:

```
entryFor(e, exportSubst, subst):
  if (regular && !exportSubst && header.type === 'blob' && header.declaredSize > threshold) → stream order   // §D4.2; S6
  content = await readBlob(ctx, e.id)                    // in-core; S4 binary included
  if (regular && exportSubst && subst.commit) content = await subst.expandFile(content)   // S7: tree id → none
```

The streaming conjunct is the **attribute**, as git's `!args->convert` — a tree-id archive
(no expansion) still reads an `export-subst` file in-core.

**Layering.** The expander is pure domain code; every datum that needs I/O is resolved by the
application layer **only when a placeholder in the file asks for it** (git evaluates lazily;
signature verification spawns a process, and the `%(describe)` budget is consumed in order).
One tokenizer serves both passes, so the requirement scan and the expansion cannot disagree:

```
domain/pretty/
  format-subst.ts      expandFormatSubst(blob, expandOne): Uint8Array        // S1–S3: '$Format:' … next '$'; fmt cut at NUL;
                       //   expandOne(accumulated, fmt) → accumulated (G19 transcodes the whole buffer)
  user-format.ts       scanPlaceholders(fmt) → tokens (git's strbuf_expand_step / format_commit_item grammar)
                       formatRequirements(tokens, budget) → { abbrev:Set<'commit'|'tree'|'parents'>, decorations, describe?: args, mailmap, signature, now }
                       formatCommit(tokens, view, env, budget) → { bytes, budget } | refusal('%(count)'|'%(total)')
  commit-view.ts       parseCommitView(raw: Uint8Array) — parse_commit_header / parse_commit_message offsets over the RAW commit bytes
  ident.ts             splitIdentLine (split_ident_line)
  date.ts              showDate(ts, tz, mode, now, localTzOffset): normal | rfc2822 | relative | iso8601 | iso8601-strict | short | human
  subject.ts           formatSubject (paragraph joined by ' '), formatSanitizedSubject (%f)
  padding.ts           %<(N[,trunc|ltrunc|mtrunc]) %>(N) %><(N) %>>(N) and the |(N) column forms; FORMATTING_LIMIT
  wrap.ts              %w(w,i1,i2) — strbuf_add_wrapped_text + rewrap_message_tail
  utf8-width.ts        git's utf8_strwidth tables (unicode-width.h: zero-width + double-width intervals)
  color.ts             %Cred|green|blue|reset, %C(spec) via color_parse_mem; emitted only with 'always,' (archive colour = never)
  trailers.ts          %(trailers[:key=,only,unfold,separator=,key_value_separator=,valueonly,keyonly]) — trailer.c block detection
  decorations.ts       %d %D %(decorate[:prefix=,suffix=,separator=,pointer=,tag=]) — log-tree.c format_decorations
  reencode.ts          the commit-encoding round trip (DC-21)
domain/mailmap/        parseMailmap (read_mailmap_line), mapUser (map_user: email case-insensitive, then name)
application/primitives/
  abbreviate-object-id.ts          abbreviateObjectId(ctx, id) — odb_find_abbrev_len over every source
  internal/ref-decorations.ts      loadRefDecorations(ctx) — load_ref_decorations(NULL, SHORT)
  internal/read-mailmap.ts         worktree .mailmap | mailmap.blob (bare default HEAD:.mailmap) | mailmap.file
  internal/verify-commit-signature.ts   check_commit_signature through ctx.command (buffer file: DC-22)
application/commands/internal/archive-subst.ts   per-archive memo: view, lazily resolved env, describe budget
```

**Placeholder semantics — git's, in archive context** (`pretty.c:format_commit_one`, `format_commit_item`, `repo_format_commit_message`):

| class | rule (source → pin) |
|---|---|
| literals | `%n`, `%xNN` (`strbuf_expand_literal`; bad hex declines), `%%` |
| magic | `%+X` LF before non-empty, `%-X` delete preceding LFs when empty, `% X` space before non-empty; the magic byte is consumed even when `X` declines (`%+N` → `N`); `%+w`/`%-w`/`% w` decline (S10) |
| declined | any placeholder whose handler returns 0 emits `%` and the scan resumes after it: `%S` (no rev), `%N` (no notes), unknown letters, malformed `%C`, `%G<other>`, unparsable `%(…)` |
| refused | `%(count)`, `%(total)` — git dies (S9); tsgit throws `formatPlaceholderUnsupported` with `{ placeholder }` (new, `src/domain/commands/error.ts`), raised when the iteration reaches the file |
| commit ids | `%H %T %P` full; `%h %t %p` via `abbreviateObjectId` |
| idents | `%a?`/`%c?` with `n e l t d D r i I h s` and mailmapped `N E L`; `%ad`/`%cd` use `DATE_NORMAL`; a malformed ident emits nothing for `n e t d D r i` and declines the rest (`format_person_part` `skip`) |
| message | `%s`, `%f`, `%b`, `%B`, `%e` (the `encoding` header verbatim) over the raw commit bytes |
| refs | `%d %D %(decorate…)` from `loadRefDecorations`: every ref + HEAD at archive time, tags peeled, `replaced` for replace refs when enabled, `grafted` for grafts/shallow; `HEAD -> <branch>` when HEAD points at a decorating branch; `tag: ` prefix; `refs/heads/`, `refs/tags/`, `refs/remotes/` shortened; no `log.excludeDecoration` (S13) |
| describe | `%(describe[:tags,abbrev=N,match=,exclude=])` — budget 1 per archive, decremented **before** argument parsing (a malformed argument still spends it); rendered from the `describe` command's result: `name` when exact, else `name-<distance>-g<abbrev>` (abbreviation per `abbrev=`, else `abbreviateObjectId`); `abbrev=0` renders the tag name alone (describe's `--abbrev=0`, interop row); a describe refusal (no names) renders empty (git: stderr discarded, stdout empty) (S8, S11) |
| reflog | `%gd %gD %gs %gn %gN %ge %gE` consume and emit nothing (no `reflog_info`) |
| signature | `%G? %GG %GS %GK %GF %GP %GT` from one `verifyCommitSignature` per archive; unsigned → `N` / `undefined` / empty (S14, S15) |
| colour | archive colour is *never*: `%Cred %Cgreen %Cblue %Creset %C(spec) %C(auto,spec)` emit nothing; `%C(always,spec)` emits `color_parse_mem`'s escape |
| layout | padding, `%w`, colour reset bookkeeping as `format_and_pad_commit`, widths by `utf8_strwidth` |
| `%m` | `>` (`get_revision_mark(NULL, …)`) |

**Abbreviation (`abbreviate-object-id.ts`).** `odb_find_abbrev_len`: base length = `core.abbrev`
as `environment.c` parses it (`auto` → automatic; a false boolean text → full length; an
integer < 4 → git's config error `abbrev length out of range`; ≥ the hex length → full) or, unset/`auto`,
`max(7, ceil((msb(n) + 1) / 2))` with `n` = the packed-object count summed over **every source**
(`packfile_store_count_objects`, approximate); then the shortest length ≥ base at which no other
object in any source shares the prefix (Part 7's per-source scans; the union). An unloadable
alternate refuses here as git's every-source reach does (§D4.4) — an archive with `%h` in a
borrower with a corrupt alternate midx refuses at that file, as git dies there. tsgit's
fixed-7 abbreviations elsewhere stay (Follow-ups).

**Describe.** `archive-subst.ts` calls the `describe` command (`commands/describe.ts`) in-process
with the parsed options (`tags`, `match`, `exclude`) on the archived commit and renders its
`DescribeResult` — the subprocess git spawns runs the same algorithm; its stderr is discarded,
so every describe refusal renders as the empty string.

**Mailmap.** New `domain/mailmap/` (grammar of `mailmap.c:read_mailmap_line`, lookup of
`map_user`), read by `read-mailmap.ts` in git's `read_mailmap` order: worktree `.mailmap` (non-bare,
working-tree root), `mailmap.blob` (bare default `HEAD:.mailmap`), `mailmap.file`. Never the
archived tree's `.mailmap` (S12).

**Signatures.** `verify-commit-signature.ts` reproduces `gpg-interface.c:check_signature` for the
three formats through `ctx.command` (the `CommandRunner` port; OpenPGP: `gpg.program --keyid-format=long
--status-fd=1 --verify <sig-file> -`, status lines parsed as `parse_gpg_output`; SSH:
`ssh-keygen -Y find-principals`/`-Y verify` with `gpg.ssh.allowedSignersFile` and
`gpg.ssh.revocationFile`; X.509: `gpgsm`). The signature is written to a transient file under
the git dir (`<gitDir>/GIT_VERIFY_BUFFER`, beside `sign-payload.ts` L93's `GIT_SIGNING_BUFFER`; declared in a `@writes` block, ADR-138) (git uses `$TMPDIR`; tsgit has no temp
port), removed in `finally`. Without a `CommandRunner` (browser) or when the program cannot be
spawned, the result is git's cannot-exec outcome: `N`, empty fields, `undefined` trust (S14).

**Dates.** `date.ts` reproduces `date.c:show_date` for the seven reachable modes. `now` is read
once per archive (`Date.now()`), the local offset from `Date#getTimezoneOffset` (`HUMAN` hides
the zone when it equals the local one) — the interop rows run both tools under `TZ=UTC`.

**Encoding (DC-21).** git's rule, per `$Format:` occurrence (a fresh `format_commit_context`
each): only when the expansion reached a header-parsing placeholder (`%a* %c* %e %B %s %f %b
%(trailers…)` — everything after `format_commit_one`'s "parse the commit header" point) and the
commit's `encoding` header names a non-UTF-8 encoding, the message is decoded to UTF-8 for the
placeholders, and afterwards the **whole output buffer so far** — the file's bytes before this
`$Format:` and every earlier expansion — is transcoded UTF-8 → that encoding; an `iconv` failure
leaves the buffer as is (S16–S16d). `expandFormatSubst` therefore threads the accumulated
buffer through `formatCommit`, which reports whether it parsed the header. How tsgit transcodes
is DC-21.

**Size, honestly.** This is git's whole user-format engine plus five dependencies tsgit lacks
(unique abbreviation, ref decorations, mailmap, signature verification, date modes) and two data
tables (Unicode widths, encoders). ~2,400 lines of `src/` and ~4,400 of tests — about as large
as the rest of this feature combined (Parts 17a–21).

### D16 — `merge` writes `ORIG_HEAD` where git does (ADR-226, Pin OH)

`commands/merge.ts` `computeMerge` (L163–200): the `ourId === theirId` short-circuit (L178)
goes — git computes the base for that case too (its Stryker note already records the
equivalence) — and `await writeOrigHead(ctx, ourId)` (`internal/merge-state.ts` L39) runs right
after `mergeBase`, before the up-to-date returns (OH2), the fast-forward (OH3), the ff-only
refusal (OH7) and `mergeCommit` (OH1, OH4, OH6, OH8). `persistConflictState` (L554) drops its own
`writeOrigHead` (L589); its write-order comment becomes `working-tree files → MERGE_HEAD →
MERGE_MSG → index`. Its "refuse before any write" guarantee now excludes `ORIG_HEAD`, as git's
(OH8). §D4.4's `mergeRun` gate moves after this write (git: L1633 before the L1663 abbreviation),
so M5ac compares `ORIG_HEAD` too. `pull` and `submodule update` (merge mode) inherit it, as git's
`pull` runs `merge`. No reflog (OH1–OH9), unchanged.

### D17 — the delta search skips objects above `core.bigFileThreshold` (ADR-226, Pin BT)

`domain/storage/delta-policy.ts`: `DeltaPolicy` gains `bigFileThreshold: number` and
`resolveDeltaPolicy(config, bigFileThreshold)` takes it; a new pure
`attemptsDelta(size, policy) = size >= DELTA_FLOOR_BYTES && size <= policy.bigFileThreshold`
(git's `should_attempt_deltas`: `< 50` and `no_try_delta`), with `DELTA_FLOOR_BYTES` moved there
from `deltify.ts` L144. `build-pack.ts` `resolveWriterPlan` (L129) passes
`readBigFileThreshold(ctx)` (Part 5). `deltify.ts` `processEmissionEntry` (L421) replaces its
`belowFloor` with `!attemptsDelta(content.length, policy)`: such an object is emitted whole and
never admitted to the window, so it is no base either (BT row 13 897). The test is on the object
size for every type, as git's `oe_size_greater_than`. Affects every `buildPack` caller (`gc`,
`push`, `bundleCreate`, `packObjects`); a pack-bytes change only for repositories with objects
above the threshold (512 MiB default).

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
- **Streaming readers (§D4.2).** `catFileBatch`: + one header-only type probe per entry (a cached
  pack window, or a ≤ 1 KiB loose slice), a blob's bytes read once. `show`: + one probe per
  object shown. `archive`: + one probe per regular-file entry (git pays the same
  `odb_read_object_info`). `buildPack`: + one memoised gate per source per build; the base-only
  path (`push`) gains the metadata read the delta path already does — one entry-header parse per
  packed object before its content read. `bench:ab` rows: `cat-file.bench.ts` batch, `show.bench.ts`
  blob, `deltify.bench.ts` (delta path unchanged) and a base-only `buildPack` row.
- **Worktree writes (§D4.3).** Success path: same calls as today (the helper reorders `rmIfExists`
  before the locate; no extra syscall). Refusal path only: one `write` + one `chmod`. Wave: one
  `everySourceLoadable` per `applyChangeset` (memoised promises); the sequential fallback runs only
  with an unloadable source. `checkout.bench.ts` row on the no-alternates fixture.
- **Gates (§D4.4).** One memoised `assertLoadable` per source per gated command; without
  alternates, the primary's memo.
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
- **`archive` attributes (§D14).** Per archive: the `info/attributes` + global reads of today's
  provider, plus one `findTreeEntry` per directory (tree objects the walk reads anyway, served
  by the object caches) and one `readBlob` per `.gitattributes` present; per entry one
  `resolveAttribute` for each of the two attributes (in-memory). Directory deferral is an array
  of ancestors (depth-bounded). A tree without `.gitattributes` pays the lookups only.
  `bench:ab` row: a new `test/bench/archive.bench.ts` (entries iterated) on the no-attributes fixture, gated.
- **`export-subst` (§D15).** Zero cost for a file without the attribute. For an expanded file:
  one `memmem`-style scan per blob, the commit parsed once per archive, each I/O datum resolved
  once per archive and only when asked: unique abbreviation = ≤ (length − base + 1) prefix scans
  per id; decorations = one ref enumeration; describe = one describe walk; signature = one
  process spawn. Informational bench row only (expansion is per-file, off every hot path).
- **`ORIG_HEAD` (§D16).** One 41-byte write per merge that reaches the merge base — the
  up-to-date and fast-forward paths gain it; the identical-commit short-circuit now pays the
  merge-base lookup (one commit, immediate).
- **Delta search (§D17).** One comparison per emitted object; objects above the threshold leave
  the window, which lowers window memory for repositories that have them. `deltify.bench.ts`
  unchanged (fixtures below the threshold).

### Part split (dependency order, TDD-sized)

Each part ends green on `npm run validate`. **Thirty parts** (Part 6b added by revision #2,
Parts 6c and 6d by revision #3, Parts 15–23 by revision #4; numbering kept stable). Rough
total: **~5,000 lines of `src/`** added or changed and **~12,600 lines of tests** (unit +
property + interop) — revision #4 adds ~2,600 / ~5,800, of which the `export-subst` expander and
its dependencies (Parts 17a–21) are ~2,400 / ~4,400. No single new `src/` module is several
hundred lines: the largest are `object-store.ts` (~290), `verify-commit-signature.ts` (~320),
`date.ts` (~250), `trailers.ts` (~250) and `internal/alternate-chain.ts` (~220); the width table
is generated data. The largest new files are the interop suites (Part 13 ~500 + ~650, Part 21
~500, Part 8 ~400), split per surface so none carries every row. Part 1 depends on nothing;
Part 3's `ObjectSourceAccess` type needs Part 2's port member; Part 6b needs Part 6; Parts 6c
and 6d need Part 6b; 6c and 6d are independent of each other.

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

**Part 6b — streamed blob open in git's stream order (§D4.1, ADR-928, ADR-929)** · src ~190 / tests ~420
- Context to pre-load:
  - `src/application/primitives/internal/blob-source.ts`: `openBlobSource(ctx, id,
    maxBufferedBytes, options?: OpenBlobSourceOptions)` (L96) — `OpenBlobSourceOptions`
    (L84, extends `StreamBlobOptions`, adds `looseMode`) gains a required `order: BlobReadOrder`,
    so the options argument becomes required; `tryDeltaCacheHit` (L135) runs only for
    `'in-core'`; `tryOpenBlobSource` (L153) splits into `locateStream` / `locateInCore`
    returning a `LocatedBlob` (`{ source, arm: 'loose', compressed } | { source, arm: 'pack',
    hit, entry }`) and `serveLocated` (the existing `resolveLoose` L308, `resolvePackBase`,
    `resolvePackDelta` — the latter takes `located.source.registry`); `verifyStoredObject`
    (L214) / `hashStoredObject` (L225): type probe, then the order by type (ADR-929). Export
    `locateBlob` / `serveLocatedBlob` (the two halves, §D4.1 end) and keep `openBlobSource` as
    their composition.
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
- Unit additions for the split: `locateBlob` returns `undefined` on a full miss after the rescan
  (no throw); `serveLocatedBlob` of a located loose / pack-base / pack-delta entry serves today's
  bytes; `openBlobSource` = composition (a miss → `objectNotFound`).

**Part 6c — every streaming reader + the every-source gate (§D4.2, §D4.4 functions and `buildPack`/`push`, ADR-930)** · src ~165 / tests ~450
- Context to pre-load:
  - `src/application/primitives/object-store.ts` (Part 5): add `assertEverySourceLoadable(ctx)`
    and `everySourceLoadable(ctx)` over `store.sources` (`source.registry.assertLoadable()`,
    `PackRegistry` interface `pack-registry.ts` L273, impl L1162).
  - `src/application/primitives/internal/blob-source.ts`: add `readBlobContentInStreamOrder(ctx,
    id)` — `openBlobSource` with `{ order: 'stream', looseMode: 'streamed' }`, drained
    (`BlobSource` `bytes` arm returned as is; `stream` arm concatenated).
  - `src/application/primitives/cat-file-batch.ts` `readOne` (L37–50): header first
    (`readDeclaredObjectHeader`, Part 6b), `isObjectNotFound` → `buildMissingEntry` unchanged; the
    `maxBytes` refusal is `objectTooLarge(id, declaredSize, maxBytes)`
    (`src/domain/objects/error.ts` L112) — same data as today's resolver cap; blob → content via the
    helper; other types → `readObjectWithSize` (L230 of `read-object.ts`).
  - `src/application/commands/show.ts` `buildForRev` (L122–127) and `buildTag` (L162–165): replace
    `readObjectStreamed` with a module-local `readShowTarget`.
  - `src/application/commands/archive.ts` `buildEntryStream` (L104–118): regular modes
    `FILE_MODE.REGULAR` / `FILE_MODE.EXECUTABLE` (`src/domain/objects/file-mode.js`) route on
    `readDeclaredObjectHeader` + `ObjectStore.bigFileThreshold` (strict `>`); `readBlob` otherwise.
  - `src/application/primitives/build-pack.ts`: `buildPack` (L91) calls
    `assertEverySourceLoadable` before `resolveWriterPlan`; `buildBaseEntries` (L144) moves to
    `readObjectMetadataWithContent` (`read-object.ts` L325) + content (carried / helper / `readRawObject`);
    `encodeEntry` (L164) takes `{ type, content }` instead of a `GitObject`.
  - `src/application/commands/push.ts` L334–352: `buildPack` only when `wants.length > 0`; the
    request body (`buildSignedRequestBody` L348 / the unsigned body L352) carries no packfile
    otherwise — check the receive-pack request builder accepts an absent pack (git:
    `send-pack.c:745`); unit row in `test/unit/application/commands/push.test.ts`.
  - `src/application/primitives/internal/deltify.ts` `processEmissionEntry` (L421–428): the
    `readRawObject` fallback routes a `blob` key (`key.type`, pack entry type) with
    `key.uncompressedSize > threshold` through the helper; the threshold is read once per
    `deltifyEntries` call from the store.
- Unit tests (memory Contexts; an alternate whose `assertLoadable` rejects is the reach detector,
  as in Part 6b):
  - `object-store.test.ts`: `assertEverySourceLoadable` rejects with the alternate's error, primary
    first (spy order); `everySourceLoadable` → `false` without throwing, `true` when all load.
  - `cat-file-batch.test.ts`: blob B packed small in the primary → rejects (reach); `bigFileThreshold`
    below B's size → served from the primary, alternate not reached; a commit → never reaches;
    missing → `{ ok: false }`; `maxBytes` below the declared size → `objectTooLarge` data, alternate
    not reached; size-lying loose blob → real bytes (existing row, kept green).
  - `show.test.ts`: blob → reach; tag → blob target → reach; commit → no reach.
  - `archive.test.ts`: regular blob above the threshold held as a delta → iteration rejects at that
    entry after yielding the earlier ones; non-delta above → served, no reach; size == threshold →
    `readBlob` (spy); symlink above the threshold → `readBlob`; executable above → streamed.
  - `build-pack.test.ts`: an unloadable alternate rejects before any read (spy on `readObject*`),
    empty `objects` included; base-only path encodes the same bytes as today (existing pack-sha rows
    stay green); a large blob held loose + packed non-delta in one source is served from the pack copy
    (spy on `looseCompressedBytes`). `deltify.test.ts`: emission read of a large blob uses the helper.
- Interop: rows M5n–M5w (Part 13).
- Mutation focus: the strict `>` in archive and deltify, the regular-mode conjunct, gate before the
  first read in `buildPack`, `maxBytes` before the open.

**Part 6d — git's residue of a refused streamed write + the pre-write gates (§D4.3, §D4.4 call sites, ADR-931)** · src ~130 / tests ~450
- Context to pre-load:
  - `src/application/primitives/internal/write-working-tree-file.ts`: new `writeStreamedBlob(ctx,
    fullPath, id, mode?)` and private `createEmptyOutput`; `writeRegularFileStream` (L129) and the
    wrappers `writeWorkingTreeFileStream` (L148) / `writeWorkingTreeEntryStream` (L168) change from
    taking a `source` to taking the blob `id` (their scanner step `unlinkSymlinkedLeadingComponent`
    stays first); `MODE_EXEC_PERM` / `MODE_REGULAR_PERM` reused.
  - Callers: `apply-changeset.ts` `writeBlobToWorkingTree` (L212–258, the final
    `streamBlob` + `writeWorkingTreeEntryStream`), `apply-merge-to-worktree.ts` L198–199,
    `commands/merge.ts` L711–712, `commands/stash.ts` L413–414 — each pair becomes one call; the
    `streamBlob` imports drop.
  - `apply-changeset.ts` `applyWriteWave` (L422–450): `everySourceLoadable(ctx)` (Part 6c) decides
    between `drainPooled` (L351, today) and a sequential `for…of` over the writes sorted with
    the comparator `materialize-tree.ts` L184 uses (`compareEntryPath`).
  - Gates (`assertEverySourceLoadable`, Part 6c): `commands/merge.ts` `mergeRun` (L148) after Part 22's
    `ORIG_HEAD` write and before every other write; `commands/cherry-pick.ts` (`cherryPickRun` L428, `cherryPickContinue` L533,
    `cherryPickSkip` L586), `commands/revert.ts` (L415, L494, L540), `commands/rebase.ts` (L457,
    L532, L573) — at the shared per-pick step if one exists, else at each entry before its first
    write; `commands/checkout.ts` `checkout` (L336) on the branch-switch path when HEAD is detached,
    before the worktree update.
- Unit tests:
  - `write-working-tree-file.test.ts` (memory adapter; `locateBlob` stubbed through an unloadable
    alternate): refusal → empty file exists, `0o755` for an executable mode, `0o644` regular, no
    chmod when mode absent; an occupant (modified file) → replaced by the empty file; full miss →
    no file, occupant removed, `objectNotFound`; serve failure (corrupt loose body) → no file; non-blob
    → no file, `unexpectedObjectType`; `createEmptyOutput` failure → its error with `cause` = the
    refusal; success → bytes + mode as today.
  - `apply-changeset.test.ts`: with an unloadable alternate and entries `a` (loose in primary),
    `base` (packed delta), `f`: `a` written, `base` empty, `f` absent, rejection = the alternate's
    error — deterministic over 20 runs; healthy store → `drainPooled` path (spy on the limiter).
  - `merge.test.ts`, `cherry-pick.test.ts`, `revert.test.ts`, `rebase.test.ts`, `checkout.test.ts`:
    unloadable alternate → refusal with the worktree, index, HEAD and state files untouched;
    checkout from an attached HEAD → no gate (residue path); from a detached HEAD → gate.
- Interop: rows M5i, M5x–M5ad (Part 13).
- Mutation focus: create-on-refusal vs unlink-on-serve-failure arms, the `undefined` arm, the
  `everySourceLoadable` switch, the detached-HEAD condition.

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

**Part 13 — lookup interop** · interop ~500 + ~650
- Two new files: `test/integration/alternates-interop.test.ts` (every row below except M5) and
  `test/integration/alternates-stream-interop.test.ts` (the M5 rows, one shared fixture built once
  per file). Both use `interop-helpers.ts`
  (`runGit`, `git`, `makePeerPair`, `disableAutoMaintenance`, `tryRunGitWithExit`),
  `pack-fixture-helpers.ts` (`flipEntryBodyByte`, `writeLooseObject`, `readSolePackPair`),
  `midx-fixture-helpers.ts` (`writeMultiPackIndex`, `mutateMidxOrThrow`).
  Remember: build the tsgit Context **after** the git subprocess writes (per-Context loose
  fanout cache).
- Rows: A1–A5, P1–P14 (via `objectSources().sources` vs `count-objects -v`), R1–R8, N1–N4,
  D1–D4, O1, U1–U3 (+U4/U5 as read outcomes), M1–M4, M5a–M5ad, X1–X3.
- M5 rows — the revision-#3 fixture of Pin M5 (git builds it; assert the precondition with
  `verify-pack -v`: `delt` non-delta, `base` a delta; the only borrower loose object is `a`, restored
  with `writeLooseObject` after the repack — pack-objects picks the delta direction). The threshold rows set `core.bigFileThreshold` in the borrower's **config file**
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
  | M5i | `checkout -- f` 128 | `checkout({ paths: ['f'] })` refusal; `f` exists, size 0 (ADR-931) |
  | M5j | `checkout -- lnk` 0 | `checkout({ paths: ['lnk'] })` restores the link |
  | M5k | `diff --stat -w HEAD~1 HEAD` 0 | `diff` with `ignoreWhitespace: 'all'` succeeds, same changed paths |
  | M5l | B also loose (copied in with `writeLooseObject`): `cat-file blob B` 0, `checkout -- f` 0 | `streamBlob(B)` bytes; checkout restores `f` |
  | M5m / M5t | `archive HEAD` 0 | `archive` iterates every entry |
  | M5n / M5o | `cat-file --batch` (B) 128 / threshold 5 → 0 | `catFileBatch([B])` rejects / yields B's bytes |
  | M5p | `show B` 128, `show HEAD:f` 128 | `show(B)`, `show('HEAD:f')` refusal |
  | M5q | threshold 1: `archive HEAD`, `--format=zip HEAD`, `archive HEAD base` 128 | iterating `archive({ treeish: 'HEAD' }).entries` rejects at `base`, after yielding exactly the pre-order entries before it |
  | M5r / M5s | threshold 1: `archive HEAD a f x lnk` 0, `archive HEAD delt` 0; threshold 5 / 6: `archive HEAD f` 0 | both tools archive a tree built by `git mktree` holding only those entries (tsgit's `archive` takes no pathspec): every entry's bytes equal `git cat-file blob` of it |
  | M5u | `pack-objects --stdout` with empty stdin, B, `--revs` HEAD → 128 | `buildPack(ctx, { objects: [] })` and `packObjects({ wants: ['HEAD'] })` refusal; no new file under `objects/pack/` on either side |
  | M5v | `bundle create` exit 1 + the fatal | `bundleCreate` refusal; no bundle file |
  | M5w | `repack -ad` 128, `gc` 128 | `gc()` refusal; the file set under `objects/` unchanged on both |
  | M5ae / M5af | push to a bare peer: delete-only → remote `x` deleted (git exit 128 afterwards); `side:refs/heads/y` 128, `y` absent | `push` delete-only succeeds and the remote's `x` is gone; `push` of `side` refuses, remote `y` absent |
  | M5x | `checkout -- f`, `checkout HEAD -- f`, `restore f` 128 | `checkout` with paths (index- and HEAD-sourced) refusal; `f` size 0, mode `0644`; `ls-files -s` unchanged; no `index.lock` |
  | M5y | `checkout -- x` 128 | `x` size 0, mode `0755` |
  | M5z | `checkout -- a f` 128; `checkout -- f` over a modified `f` 128 | `a` restored, `f` size 0; the modified `f` replaced by size 0 |
  | M5aa | on `side`: `checkout main`, `switch main`, `checkout -f main`, `reset --hard main` 128 | branch-switch `checkout` and hard `reset` refusal; worktree listing (name, size, mode) equal to git's — `a` 4, `base` 0, `d`, nothing else; HEAD → `side`; index = C1's; no `index.lock` |
  | M5ab | at `main`: `stash apply` 128 | `stashApply` refusal; `s` size 0; HEAD, index unchanged |
  | M5ac | on `side`: `merge --ff-only main`, `merge --no-ff main`, `cherry-pick main`, `revert HEAD` (on `main`), `rebase main` 128 | each refusal with worktree, index, HEAD, refs and sequencer/merge state files untouched; `merge` leaves `ORIG_HEAD` = the old HEAD on both (§D16) |
  | M5ad | detached at C1: `checkout main`, `merge --ff-only main`, `cherry-pick main` 128 | refusal, worktree untouched; `reset --hard main` detached behaves as M5aa |

  Worktree comparisons run on two peer copies of the fixture (`makePeerPair`), git on one and
  tsgit on the other, umask 022 for both; mode compared as `stat.mode & 0o777` (Node adapter).
  The option spellings of `checkout`, `reset`, `stashApply`, `bundleCreate` are the planner's to
  confirm against their public types.

**Part 14 — gc/fsck interop, parity, bench, docs** · interop ~350 / other ~200
- `test/integration/alternates-gc-fsck-interop.test.ts`: G1–G5, F1–F5.
- `test/parity/scenarios/`: extend Part 5's scenario — one cross-adapter row (memory + node)
  with an in-root alternate; one memory row for an out-of-root alternate (ADR-916).
- `test/bench/`: the `bench:ab` rows of §Perf (`cat-file`, `log`, `status`, `add`).

**Revision #4 parts (Parts 15–23).** Dependency order: Parts 6c and 15 → 16 → 21; Part 17a → 17b, 17c,
18a, 18b → 21; Part 19a needs Parts 5 and 7; Part 19b and Part 20 need 17a (Part 20 also
DC-21); Part 21 needs 6c, 16, 17a–c, 18a–b, 19a–b, 20. Part 22 depends on nothing and lands
**before** Part 6d (6d places the `mergeRun` gate after its write). Part 23 needs Part 5.

**Part 15 — directory-only patterns + the tree attribute provider (§D14, R16)** · src ~90 / tests ~300
- Context to pre-load:
  - `src/domain/attributes/resolve-attribute.ts`: `resolveInSource` (L22) / `resolveAttribute`
    (L45) — a trailing `/` on `path` marks a directory; strip it for `rule.compiled.test`, skip a
    rule with `directoryOnly` (`AttributeRule`, `parse-gitattributes.ts` L10) for a non-directory.
  - `src/application/primitives/internal/read-gitattributes.ts`: `buildAttributeProvider` (L110)
    → `buildAttributeProviderFrom(ctx, readDirAttributes)`; `readDir` (L32) becomes the worktree
    reader; new `buildTreeAttributeProvider(ctx, tree: ObjectId)` with the tree reader of §D14
    (`findTreeEntry`, `internal/resolve-tree-path.ts` L66; `readBlob`, `read-blob.ts`; modes
    `FILE_MODE.REGULAR`/`EXECUTABLE`, `domain/objects/file-mode.ts`; cap `MAX_GITATTRIBUTES_BYTES`,
    `primitives/types.ts`, refusal `gitattributesFileTooLarge` as `loadCappedUtf8` raises it).
- Tests: `test/unit/domain/attributes/resolve-attribute.test.ts` — `foo/` vs file `foo`
  (unspecified), vs `foo/` (set), nested `x/foo/` (set); existing rows unchanged.
  `resolve-attribute.properties.test.ts`: a rule without `directoryOnly` answers the same for
  `p` and `p/` (lens 2, 100). `test/unit/application/primitives/internal/read-gitattributes.test.ts`:
  tree provider reads root and nested `.gitattributes` from the tree, ignores the worktree file,
  works with `workDir` undefined (bare), ignores a symlink-mode `.gitattributes`, keeps
  `info/attributes` precedence and macros from the tree root.
- Mutation focus: the trailing-slash test, the `directoryOnly` conjunct, the regular-mode check.

**Part 16 — `archive` honours `export-ignore` (§D14, Pin E)** · src ~90 / tests ~350 + interop ~250
- Context to pre-load: `src/application/commands/archive.ts` `buildEntryStream` (L106–119) per
  §D14's sketch; `walkTree` (`primitives/walk-tree.ts` L246) unchanged; `validateIndexPath`
  stays first for every walked entry; `FILE_MODE.DIRECTORY`/`GITLINK`.
- Unit (`test/unit/application/commands/archive.test.ts`, memory Contexts with committed
  `.gitattributes`): one isolated test per exit — file set; unset/string/unspecified kept;
  macro; directory by name and by `dir/`; `dir/**` (dir emitted, child not); dir with only an
  ignored subdirectory not emitted; empty subtree not emitted; gitlink matched as `path/`;
  symlink ignored; worktree `.gitattributes` disagreeing with the tree → tree wins; bare Context;
  tree-id tree-ish; invalid name inside an ignored subtree still refuses.
- Interop `test/integration/archive-export-interop.test.ts` (new; `archive-interop.test.ts`
  helpers): E1–E11, E13 (default half), E14–E17 — entry list (path, mode) equal to
  `git archive --format=tar | tar -t`, with git's queued-directory rule; E12 recorded only.
- Mutation focus: flush-before-check order, the ancestor filter, the gitlink slash.

**Part 17a — expander core: scanner, tokenizer, interpreter, commit view (§D15)** · src ~350 / tests ~600
- New `src/domain/pretty/{format-subst,user-format,commit-view,ident,subject}.ts` + `index.ts`;
  export from `src/domain/index.ts`. `FormatEnv` (resolved data, all optional) and
  `FormatBudget` (`{ describe: 0 | 1 }`) types live in `user-format.ts`.
- Covers: S1–S3 scanning; literals; magic (incl. `%+N` → `N`, `%+w` declined); declined `%`;
  `%(count)`/`%(total)` refusal value; `%H %T %P %h %t %p` from env; idents `n e l t` +
  `N E L` through an env `mapUser`; `%s %f %b %B %e %m`; `%g*` empty; `%S %N` declined.
  `formatRequirements` uses the same tokenizer.
- New error `formatPlaceholderUnsupported(placeholder)` in `src/domain/commands/error.ts`
  (beside `ambiguousOidPrefix` ~L879) — data `{ placeholder }`.
- Tests: `test/unit/domain/pretty/*.test.ts` — every Pin S row reachable without I/O as literal
  bytes. `format-subst.properties.test.ts`: lens 3 totality on arbitrary bytes (200); identity on
  blobs without `$Format:` (200); lens 4 — k well-formed `$Format:%H$` occurrences ↔ k
  expansions (100). `user-format.properties.test.ts`: `formatRequirements` asks for X ⇔
  `formatCommit` reads X (recording env, 200).

**Part 17b — date modes (`domain/pretty/date.ts`)** · src ~250 / tests ~400
- `showDate(timestamp, tzOffsetMinutes, mode, nowSeconds, localOffsetMinutes)` for `normal`,
  `rfc2822`, `relative`, `iso8601`, `iso8601-strict` (`Z` for `+0000`), `short`, `human`
  (`date.c:show_date`, `show_date_relative`, `show_date_normal`). Tests: Pin S date rows;
  relative boundaries (seconds/minutes/hours/days/weeks/months/years, "N years, M months",
  future); human same-day / same-year / other-year. Property: `iso8601-strict` round-trips
  through `Date.parse` to the timestamp (lens 1, 200).

**Part 17c — layout: colour, padding, wrap, widths** · src ~450 (≈ 200 of width table) / tests ~500
- `domain/pretty/{color,padding,wrap,utf8-width}.ts` per §D15. The width tables are generated
  from git's `unicode-width.h` at 2.55 (commit the generator under `tooling/`, not the network
  fetch). Tests: Pin S colour/padding/wrap rows; `FORMATTING_LIMIT` boundary; East-Asian wide
  and zero-width code points. Property: `%<(N)` output width == max(N, width(input)) (lens 2, 200).

**Part 18a — trailers (`domain/pretty/trailers.ts`)** · src ~250 / tests ~450
- `trailer.c` block detection (last paragraph, ≥ 25 % trailer lines or a git-generated
  prefix, continuation lines, `trailer.separators`, configured `trailer.<token>.key`) and the
  `%(trailers:…)` options. Config keys added to `ParsedConfig` (`primitives/config-read.ts` L53):
  `trailer.separators`, `trailer.<token>.key`. Property: lens 1 — a message built from
  generated trailers yields them back with `only` (200).

**Part 18b — decorations format + mailmap (domain)** · src ~200 / tests ~350
- `domain/pretty/decorations.ts` (`format_decorations`: `HEAD -> branch`, `tag: `, shortening,
  prefix/suffix/separator/pointer/tag options with `%n`/`%xNN` expansion in values) over a
  structured `Decoration[]`; `domain/mailmap/{parse-mailmap,map-user,index}.ts`. Property for
  `parseMailmap`: totality (lens 3, 200); lens 4 counting of well-formed lines (100).

**Part 19a — abbreviation, ref decorations, mailmap reader (application)** · src ~280 / tests ~450
- New `src/application/primitives/abbreviate-object-id.ts` (`abbreviateObjectId(ctx, id)`;
  base length from `core.abbrev` — add `abbrev` to `ParsedConfig.core` — or the packed count over
  `objectSources`/`registry` per source; uniqueness via Part 7's per-source `scanLoose`/
  `scanPacks` in `resolve-oid-prefix.ts` L67/L89, exported internally). Export from
  `primitives/index.ts`; the browser-surface audit needs a parity-scenario call.
- `internal/ref-decorations.ts`: `enumerateRefs` (`enumerate-refs.ts` L16) + `readHeadRaw`,
  tag peeling via `peel` (`internal/peel.ts`), `refs/replace/<oid>` → `replaced`,
  `loadShallowSet` (`internal/shallow-set.ts` L81) → `grafted`.
- `internal/read-mailmap.ts`: worktree `.mailmap` (`loadCappedUtf8`), `mailmap.blob`
  (`revParse` + `readBlob`; bare default `HEAD:.mailmap`), `mailmap.file`; add `mailmap` to
  `ParsedConfig`.
- Tests: abbreviation base length at count boundaries (2^13, 2^14 objects simulated through a
  registry double), `core.abbrev` 4/12/`no`, X1-style ambiguity across sources, unloadable
  alternate refuses; decoration order attached/detached (S13); mailmap source order and bare
  default (S12).

**Part 19b — signature verification (application)** · src ~320 / tests ~450
- New `internal/verify-commit-signature.ts` per §D15; reuses `sign-payload.ts` program
  resolution (`DEFAULT_OPENPGP_PROGRAM`, `DEFAULT_SSH_PROGRAM`, `gpg` config L189 of
  `config-read.ts`) and `CommandRunner` (`src/ports/command-runner.ts`; `ctx.command`,
  `ports/context.ts` L304). Add `gpg.ssh.allowedSignersFile` / `revocationFile` to
  `ParsedConfig`. Tests (fake runner): `GOODSIG`, `BADSIG`, `EXPSIG`, `EXPKEYSIG`, `REVKEYSIG`,
  `ERRSIG`, trust levels → `%GT`; ssh principal found / not found; no runner → `N`; spawn
  failure → `N`; buffer file (DC-22 option a) removed on every exit. Interop S14/S15 with a fake `gpg.program`
  script (both tools), and one real-`gpg` row `skipIf` no `gpg` on PATH.

**Part 20 — commit-encoding round trip (§D15, DC-21)** · src ~150 / tests ~250
- `domain/pretty/reencode.ts` per the ratified DC-21 option. Tests: S16 bytes; invalid
  sequence → unconverted; unknown label → unconverted.

**Part 21 — `archive` expands `export-subst` (§D15, R15)** · src ~150 / tests ~400 + interop ~500
- Context to pre-load: `archive.ts` `classifyOid` (L66) already yields `commit`;
  `buildEntryStream` gains the `subst` handle; new `commands/internal/archive-subst.ts`
  (per-archive memo: raw commit via `readRawObject`, `parseCommitView`, lazily resolved env,
  describe budget); the stream-order routing of Part 6c takes the `!exportSubst` conjunct;
  `describe` (`commands/describe.ts` L78) for `%(describe)`.
- Unit (`archive.test.ts`): tree id → bytes unchanged; tag → peeled commit; symlink unchanged;
  file above the threshold with the attribute → expanded and read via `readBlob` (spy); budget
  consumed by the first file in pre-order, literal in the second; malformed describe args spend
  it; `%(count)` → iteration rejects at that file with `{ placeholder: '%(count)' }` after the
  earlier entries; no I/O resolver called for a file without the matching placeholder (spies).
- Interop `test/integration/archive-export-interop.test.ts` (Part 16's file, second
  `describe`): every Pin S row — expanded bytes of each file equal `git archive | tar -xO`
  (TZ=UTC both, fixed dates, `now`-relative rows with a ±1 s tolerance window fixed by setting the
  commit dates relative to the test's own clock); S9 refusal on both.
- Mutation focus: the attribute conjunct in the routing, `S_ISREG` gate, budget decrement order.

**Part 22 — `merge` writes `ORIG_HEAD` before the outcome (§D16, R17)** · src ~15 / tests ~150 + interop ~150
- Context to pre-load: `commands/merge.ts` `computeMerge` (L163–200), `persistConflictState`
  (L554–612, `writeOrigHead` at L589), `internal/merge-state.ts` `writeOrigHead` (L39).
- Unit (`test/unit/application/commands/merge.test.ts`): `ORIG_HEAD` = old HEAD after
  up-to-date (identical and ancestor), fast-forward, `fastForward: 'never'`, clean merge,
  conflict, ff-only refusal, would-overwrite refusal; not written when `opts.rev` does not
  resolve or a merge is pending; no `logs/ORIG_HEAD`. Existing rows asserting "no ORIG_HEAD"
  after a refusal flip — justified by OH7/OH8.
- Interop (`test/integration/merge-interop.test.ts`): OH1–OH4, OH6–OH8 — `ORIG_HEAD` bytes
  equal on both tools.

**Part 23 — delta search skips objects above `core.bigFileThreshold` (§D17, R18)** · src ~25 / tests ~150 + interop ~100
- Context to pre-load: `domain/storage/delta-policy.ts` `DeltaPolicy` (L61), `resolveDeltaPolicy`
  (L76); `primitives/build-pack.ts` `resolveWriterPlan` (L129–132); `internal/deltify.ts`
  `DELTA_FLOOR_BYTES` (L144), `processEmissionEntry` (L421–446); `readBigFileThreshold` (Part 5).
- Unit: `test/unit/domain/storage/delta-policy.test.ts` — `attemptsDelta` at 49/50 and at
  threshold/threshold+1; `deltify.test.ts` — an object above the threshold is emitted whole and
  never becomes a base (the BT 13 897 shape, sizes scaled down via a low threshold).
- Interop (`test/integration/delta-pack-interop.test.ts`): Pin BT rows — the whole/delta
  verdict per blob equals git's `verify-pack -v` at each threshold (`core.bigFileThreshold` in the
  repository config file for both tools).

## Decisions

### Ratified (ADR-914 … ADR-933)

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
| DC-17 | ADR-929 | `verifyStoredObject`: header-only type probe, then `'stream'` for a blob, `'in-core'` otherwise — git's `parse_object` sequence (adopted as recommended) — §D4.1 |
| DC-18 | ADR-930 | **every git streaming reader follows the stream order**: `cat-file --batch` blob contents and `show <blob>` always, `archive` / `pack-objects` above `core.bigFileThreshold` under git's condition (user-ratified; deviates from the draft's recommendation) — §D4.2 |
| DC-19 | ADR-931 | **a refused streamed checkout leaves git's empty file** (user-ratified; deviates from the draft's recommendation) — §D4.3 |
| DC-20 | ADR-932 | the refused streamed write creates the empty file **on refusal** (locate first; create + rethrow on a locate refusal) — adopted as recommended (option b) — §D4.3 |
| — | ADR-933 | **`archive` honours `export-ignore` and `export-subst`** (user-ratified; folded into this feature) — §D14, §D15 |

### Adopted under ADR-226 (faithful) — revision #3

Each sub-choice below surfaced while folding ADR-930/931 and reduced to "reproduce git" vs
"diverge"; the faithful option is designed, none is a candidate.

| # | sub-choice | adopted (pin) |
|---|---|---|
| F1 | ADR-930's `pack-objects` premise: git dies at start-up on any unloadable source, before streaming (`prepare_in_pack_by_idx`) | `buildPack` gates every source before any read — covers `packObjects`, `bundleCreate`, `gc`, and `push` when it needs pack data (M5u–M5w, M5af); the stream routing of ADR-930 is kept and changes only the copy served (§D4.2) |
| F2 | Writers that git refuses **before** writing, through an every-source abbreviation tsgit never computes | the every-source gate at git's point: `merge`, `cherry-pick`, `revert`, `rebase`, `checkout` from a detached HEAD (M5ac, M5ad; §D4.4) |
| F3 | Residue under `applyChangeset`'s concurrent wave (arbitrary subset) vs git's index-order prefix | sequential wave in changeset order when any source is unloadable; concurrent otherwise (M5aa; §D4.3) |
| F4 | A streamed write whose blob is absent everywhere | occupant removed first, no file left (git: unlink, create, NULL stream, unlink, in-core failure) |
| F5 | A serve failure or a non-blob during a streamed write | output unlinked (`streaming_write_entry` L144–145) |
| F6 | Mode of the residue | git's `create_file` mode less umask: `0755` executable, `0644` regular (M5x, M5y) |
| F7 | `archive` refusal timing | the lazy entry stream rejects at the refused entry, after yielding every earlier one (M5q) |
| F8 | `catFileBatch` read sequence | type first (git's info read), then the stream order for a blob, in-core for the rest (M5n) |
| F9 | `buildPack` routing condition | "blob above the threshold", no reuse term — tsgit always re-encodes, i.e. reads git's `--no-reuse-object` set (§D4.2) |
| F10 | A delete-only `push` would hit F1's gate through its empty pack; git sends no pack for it | `push` skips `buildPack` and the packfile when no command needs pack data (M5ae, M5af; §D4.4) |

### Adopted under ADR-226 (faithful) — revision #4

Each sub-choice below surfaced while folding ADR-933 and the two pre-existing gaps, and reduced
to "reproduce git" vs "diverge"; the faithful option is designed, none is a candidate.

| # | sub-choice | adopted (pin) |
|---|---|---|
| G1 | Attribute source for `archive` | the archived tree's `.gitattributes` (git's `GIT_ATTR_INDEX` over the unpacked tree), bare repositories included; `info/attributes` and `core.attributesFile` kept (E11, E13–E16; §D14) |
| G2 | What "set" means | `ATTR_TRUE` only — `export-ignore=true` and `-`/`!` forms do not count (E2) |
| G3 | Directory and gitlink checks | checked as `<path>/`, so directory-only patterns match them (E4, E5, E9) |
| G4 | When a directory entry is emitted | queued; flushed only when a non-directory descendant reaches its export-ignore check, before that check — empty subtrees and all-ignored-subdirectory dirs vanish (E6, E7, E10). Fixes tsgit's emission of empty subtrees, pre-existing |
| G5 | Directory-only attribute patterns elsewhere | `resolveAttribute` honours `directoryOnly` for every caller (R16, E9) — pre-existing gap, small, on this path |
| G6 | A symlinked `.gitattributes` in the tree | not read (E17) |
| G7 | Path validation inside an ignored subtree | every walked entry validated — git unpacks and verifies the whole tree first |
| G8 | Streaming conjunct | the `export-subst` attribute itself, not whether a commit exists (§D4.2, S6) |
| G9 | `$Format:` scanning | first later `$` across lines; no `$` → verbatim; format cut at NUL; binary expanded; symlink never; tree id never (S1–S7) |
| G10 | `%(describe)` cap | one per archive, archive order, spent before argument parsing and even when describe yields nothing (S8, S11) |
| G11 | `%(count)` / `%(total)` | refusal at that file, after earlier entries (S9; F7 posture) |
| G12 | Mailmap source | worktree `.mailmap` / `mailmap.blob` (bare default `HEAD:.mailmap`) / `mailmap.file` — never the archived tree's (S12) |
| G13 | Decoration source | the repository's refs at archive time, `grafted` for shallow commits, `replaced` for replace refs, no exclusion config (S13) |
| G14 | Colour | never, except `%C(always,…)` (Pin S colour rows) |
| G15 | Signature verification off-Node or without the program | git's cannot-exec outcome: `N`, empty fields, `undefined` (S14) |
| G16 | `%h %t %p` length | `odb_find_abbrev_len` over every source; an unloadable alternate refuses there as git dies (§D15) |
| G17 | `ORIG_HEAD` timing | after the merge base, before every outcome and the ff-only / would-overwrite refusals, no reflog (OH1–OH9; §D16) |
| G18 | Big objects in the delta search | excluded as target **and** base, strict `>`, every type (BT; §D17) |
| G19 | Transcoding scope | whole accumulated buffer, only after a header-parsing placeholder, per occurrence (S16–S16d) — the mechanism; the label coverage is DC-21 |

### New decision candidates (uncovered by revision #4)

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| DC-21 | How `export-subst` transcodes for a commit whose `encoding` header is not UTF-8 (G19). git uses `iconv`; tsgit has no dependency and only the platform's WHATWG `TextDecoder` (decode-only, a smaller label set than `iconv`) | (a) **WHATWG-backed**: decode with `TextDecoder(label, { fatal: true })`; encoders derived from the decoder and memoised per label — single-byte labels by 256 decodes, the CJK labels (Shift_JIS, EUC-JP, EUC-KR, GBK, Big5) by one pass over their 65 536 two-byte sequences; forms outside that pass (`gb18030` four-byte, EUC-JP three-byte), labels WHATWG lacks and any failure behave as git's failed `iconv` (buffer unconverted) — the residual is recorded in the ADR; (b) **byte-transparent**: never transcode — exact for every UTF-8 commit and for non-UTF-8 commits whose files and inserted text are ASCII; diverges on the S16c/S16d shapes; (c) **refuse** expansion for a non-UTF-8 commit — a refusal git does not have | **(a)** | (a) matches git on every label both stacks know, including S16c/S16d, at ~150 `src` lines and a one-off table build only when such a commit is archived; (b) costs nothing but ships known-wrong bytes for any non-UTF-8 commit whose expansion touches the header and whose file holds non-ASCII text before it; (c) adds a divergence (ADR-226) to avoid one |
| DC-22 | Where signature verification puts the detached signature `gpg`/`ssh-keygen` read from a file (git: a `$TMPDIR` temp file; tsgit's `FileSystem` is repo-rooted and has no temp port) | (a) **transient file under the git dir** (`<gitDir>/GIT_VERIFY_BUFFER`), removed in `finally` — the `sign-payload.ts` L93 SSH-signing precedent; `archive` gains a `@writes` entry (ADR-138) for a read-only command; (b) **adapter-owned temp file**: `CommandRunner` gains an optional "stage these bytes as a file argument" capability, the Node adapter writing under `os.tmpdir()` — git's location, a port change on one adapter; (c) **no verification**: `%G*` always renders the unsigned outcome — a divergence for signed commits | **(a)** | (a) reuses the existing signing mechanism and confines the write to the git dir; the transient file is the only observable difference from git and exists only while the process runs. (b) matches git's location at the cost of a port extension used by one caller. (c) ships wrong `%G?` bytes for every signed commit |

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
- **Streaming readers and gates** (Part 6c): per reader, reach vs no-reach with the rejecting
  alternate; the strict `>` boundary in `archive`/`buildPack`; `buildPack` rejects before its first
  read, empty input included.
- **Worktree residue** (Part 6d): one isolated test per `writeStreamedBlob` exit (refusal → empty
  file with mode; miss → no file; serve failure → no file; create failure → cause chain); the wave's
  deterministic index-order residue repeated 20×; each gated command untouched on refusal.
- **Freshen** (Part 8): one isolated test per exit of `freshenObject` (§Part 8 list) with
  `vi.setSystemTime` back-dating; mutation targets: the cruft check, the `freshenedPacks` memo,
  the absent-`utimeNow` arm, the adapter-code vs rethrow split.
- **Acceleration** (Parts 9–10): commit-graph CG1–CG6 shapes and the flipped missing-layer row;
  bitmap order BM2–BM6 with loader spies.
- **gc / fsck** (Parts 11–12): unit rows mirroring G1–G5 and F1–F5/M4 with a memory store.
- **Interop**: five files, one per surface — `alternates-interop.test.ts` and
  `alternates-stream-interop.test.ts` (Part 13),
  `object-freshen-interop.test.ts` (Part 8, `interopSurface: objectFreshen`),
  `alternates-acceleration-interop.test.ts` (Parts 9–10), `alternates-gc-fsck-interop.test.ts`
  (Part 14). Reconstruct X1 from `ambiguousOidPrefix` data and O1 from `objectSources()`; fsck rows
  compare structured findings + exit bits to git's (ADR-249). Immutable-file rows are darwin-only
  (`chflags uchg`). Revision #4 adds `archive-export-interop.test.ts` (Parts 16, 21) and rows in
  `merge-interop.test.ts` (Part 22) and `delta-pack-interop.test.ts` (Part 23).
- **Archive attributes** (Parts 15–16): attribute-resolution unit rows for directory-only
  patterns (and a property: non-directory-only rules answer `p` and `p/` alike); tree provider
  vs worktree; one isolated `archive` test per `buildEntryStream` exit (§Part 16); interop E-rows
  compare entry lists with `git archive | tar -t`.
- **Expander** (Parts 17a–20): domain rows = Pin S literal bytes per placeholder class;
  properties — scanner totality/identity/counting, requirement-scan ⇔ evaluation equivalence
  (recording env), padding width, ISO-strict date round trip, trailer and mailmap grammars;
  application resolvers with doubles (registry, ref store, fake `CommandRunner`) and one
  isolated test per resolver exit; dates and relative modes under `vi.setSystemTime`.
- **Archive expansion** (Part 21): unit — attribute conjunct, budget order, lazy resolution
  (spies prove a resolver is not called without its placeholder), refusal mid-stream; interop —
  every Pin S row's bytes vs `git archive | tar -xO`, both tools under `TZ=UTC`, now-relative
  rows built from dates relative to the test clock.
- **`ORIG_HEAD`** (Part 22): unit per merge outcome and refusal; interop OH bytes.
- **Big-file delta** (Part 23): `attemptsDelta` boundaries; deltify target-and-base exclusion;
  interop whole/delta verdict per Pin BT row via `verify-pack -v`.
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
- Abbreviations git prints **after** its writes (`commit`'s summary line, `reset`'s `HEAD is now
  at`): git exits 128 with the on-disk change made; tsgit succeeds — exit status only, the M5k /
  ADR-249 precedent.
- `worktree add` in a borrower with an unloadable alternate: not pinned; tsgit's writes go through
  `applyChangeset` and inherit §D4.3.
- Observed, not changed here (discuss before scheduling): tsgit's chain-file grammar
  (`parseChainLayerHashes` trims and drops blank lines) differs from git's fixed-width read
  (`invalid commit-graph chain: line '…' not a hash`, `commit-graph chain file too small`).

## Follow-ups (pre-existing gaps found while pinning; not on this change's path or not small)

- `archive` has no `--worktree-attributes` option (E13, second half): `ArchiveOptions` carries only `treeish`.
- `archive` applies `convert_to_working_tree` (smudge, `eol`, `ident`, `working-tree-encoding`) to in-core regular files before `export-subst` (`archive.c:object_file_to_archive`); tsgit emits raw blob bytes, and tsgit's checkout implements smudge only.
- Fixed 7-hex abbreviations (`checkout.ts` L94, `rebase.ts` L151, `domain/merge/merge-labels.ts` L16, `domain/diff/patch-serializer.ts` L57) where git writes `find_unique_abbrev` output into on-disk data — candidates for `abbreviateObjectId` (Part 19a).
- `merge` of unrelated histories: git refuses (exit 128 without `--allow-unrelated-histories`, OH9); tsgit merges against the empty tree (`docs/design/commands.md` L1285, no ADR).
- `ORIG_HEAD` in a reftable repository lives in the reftable (OH11); `writeOrigHead` (`internal/merge-state.ts` L39) writes a file — affects `merge` and `rebase`.
- `reset` writes `ORIG_HEAD` in git; `commands/reset.ts` never references it (not pinned here).
- Replace refs: git reads `refs/replace/` replacements on object reads (and archives the replacement commit); tsgit ignores them (Part 19a only renders the `replaced` decoration).
- Mailmap in `shortlog`/`log` (git applies `.mailmap` by default) — `domain/mailmap/` (Part 18b) can serve them.
- The `delta` attribute (`-delta`) disables the delta search per path (`builtin/pack-objects.c` L1514 `no_try_delta(path)`); tsgit's pack builder has no path-attribute input.
- `merge` from a detached HEAD: tsgit refuses (`unsupportedOperation`), git merges — check whether an ADR covers it.
- `archive` of an annotated tag that points at a **tree**: git archives the tree without commit metadata (`lookup_commit_reference_gently` fails, `parse_tree_indirect` peels); tsgit's `classifyOid` (`archive.ts` L71–82) throws `unexpectedObjectType` — not pinned here.
