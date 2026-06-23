# Design — `fsck` (repository integrity check)

> Brief: Ship the Tier-1 `fsck` command — git's `git fsck`: verify the connectivity
> and validity of every object in the store, returning the findings as structured
> data only (ADR-249). The library emits typed findings (`missing` / `dangling` /
> `unreachable` / `broken-link` / `bad-object` / `hash-mismatch` / `bad-ref` /
> `root` / `tagged`); reconstructing git's `dangling commit <sha>` / `missing blob
> <sha>` lines, their stdout/stderr stream routing, and the exit-code bitmask is
> the caller's job. v1 reproduces git's **full** finding space: object-content
> validation against git's named msg-id catalogue (with `--strict` WARN→ERROR
> upgrades), connectivity/reachability, and the `git refs verify` ref-content pass
> (`badRefContent`, refs-pass exit-bit 8; composite exit 10).
> Status: draft → self-reviewed ×3 → accepted → scope-fold revision (ADRs 411–414)

## Context

`fsck` is backlog **24.3**, the first Wave-C leaf utility (low-coupling, no
structurally-invasive layout change). It composes existing read primitives and
adds the project's first **whole-object-database scan** and **full-graph
reachability closure** — neither exists today.

Constraints it inherits:

- **Prime directive (ADR-226):** replicate git's observable DATA and on-disk
  behaviour byte-for-byte. fsck reads only; its faithfulness surface is *which
  findings it computes* + *the exit-code class* + *the refusal conditions*, pinned
  empirically below and frozen by an interop test.
- **Structured-output (ADR-249):** the command returns typed findings, never a
  rendered line and never a `bytes`. git routes findings across stdout
  (reachability taxonomy) and stderr (integrity faults); both are **caller
  rendering** — the library ships the fields and lets the consumer place them. No
  rendering-only flag (`--name-objects`, `--verbose`, `--progress`) may appear on
  the surface.
- **Hexagonal tiers:** `repository → commands → primitives → domain`. fsck is a
  Tier-1 command built from Tier-2 primitives — the same blocks a library user
  gets. Finding types are `readonly` discriminated unions of branded domain types,
  following the `domain/diff/diff-change.ts` precedent (one interface per variant,
  discriminated on `type`).

Prior structured-inspection commands set the shape: `whatchanged`
(`docs/design/whatchanged.md`) and `shortlog`
(`src/application/commands/shortlog.ts`) are the closest templates — `ctx` first,
one readonly options object, a `Promise` of a structured result, no rendered
strings. fsck diverges on the repository gate alone: it uses `assertRepository`
(repo exists), not `assertOperationalRepository`, because it must run on the
broken repo it is meant to diagnose (ADR-414).

### Pre-chewed substrate (exact paths / symbols / signatures)

**Object reading & integrity** — `src/application/primitives/read-object.ts`
- `readObject(ctx, id, options?: ReadObjectOptions): Promise<GitObject>`;
  `ReadObjectOptions = { verifyHash?: boolean /*default true*/; maxBytes?: number }`.
- Errors (factories in `src/domain/objects/error.ts`, all `TsgitError`, `.data`
  discriminated on `code`):
  - `objectNotFound(id)` → `{ code: 'OBJECT_NOT_FOUND', id }` (neither loose nor any pack holds the oid).
  - `objectHashMismatch(expected, actual)` → `{ code: 'OBJECT_HASH_MISMATCH', expected, actual }` (content hash ≠ requested id; from `finalize`, only when `verifyHash`).
  - `objectTooLarge(id, actualSize, limit)` → `{ code: 'OBJECT_TOO_LARGE', … }`.
  - parse failures (`src/domain/objects/header.ts`, `git-object.ts`, `tag.ts`,
    `commit`/`tree`/`identity`): `invalidObjectHeader` (`INVALID_OBJECT_HEADER`),
    `invalidCommit` (`INVALID_COMMIT`), `invalidTag` (`INVALID_TAG`),
    `invalidTreeEntry` (`INVALID_TREE_ENTRY`), `invalidIdentity`
    (`INVALID_IDENTITY`), `invalidFileMode` (`INVALID_FILE_MODE`).
- No public `objectExists` / `hasObject` (only the private `objectExistsLocally`
  in `commands/fetch-missing.ts`). Loose existence is
  `ctx.fs.exists(looseObjectPath(...))`; pack existence is `PackRegistry.lookup(id)`.

**Object-DB enumeration** — *NONE today; `enumerateObjects` is the net-new public
Tier-2 primitive (ADR-413, D6).* Building blocks: `objectsDir(gitDir, prefix)` /
`looseObjectPath(gitDir, id)` (`src/application/primitives/path-layout.ts`),
`PackRegistry.all()` (`src/application/primitives/pack-registry.ts`), and
`PackIndex.objectCount` + the sorted SHA table at `IDX_SHA_TABLE_OFFSET=1032`
stride `IDX_SHA_LENGTH=20` (`src/domain/storage/pack-index.ts`, which has
`entryOffsets` and `findByPrefix` but **no all-oid iterator**). The iterator
addition mirrors `findByPrefix`'s body exactly — for `i` in `[0,
index.objectCount)` yield `bytesToHex(index._bytes.subarray(IDX_SHA_TABLE_OFFSET +
i * IDX_SHA_LENGTH, IDX_SHA_TABLE_OFFSET + (i + 1) * IDX_SHA_LENGTH)) as ObjectId`
(the table is already sorted ascending; no fanout walk needed since every entry is
wanted). Export it (e.g. `allObjectIds(index)`) alongside the existing
`entryOffsets`/`lookupPackIndex`.

**Object-content validation** — *net-new `domain/fsck/` validator module (ADR-412,
D2).* tsgit's parsers (`src/domain/objects/{header,git-object,commit,tree,tag,
identity}.ts`) already throw on the structural faults (`INVALID_OBJECT_HEADER`,
`INVALID_COMMIT`, `INVALID_TREE_ENTRY`, `INVALID_TAG`, `INVALID_IDENTITY`,
`INVALID_FILE_MODE`, `OBJECT_HASH_MISMATCH`), but git's named fsck catalogue
(`treeNotSorted`, `zeroPaddedFilemode`, `missingSpaceBeforeEmail`, … — the full
set pinned below) is a separate severity-classified pass git runs *on top of*
parsing. The validator takes a parsed object + its kind and returns the ordered
list of `(msgId, severity)` checks it fails; the command maps each to a
`bad-object` finding. The msg-id → default-severity map and the strict-upgrade set
(WARN-class → ERROR) are the module's core tables, pinned against real git below.

**Roots** — `enumerateRefs(ctx): Promise<ReadonlyArray<RefName>>`
(`src/application/primitives/enumerate-refs.ts`) dedups HEAD + loose `refs/**` +
packed-refs. `resolveRef(ctx, name, { peel?: false }): Promise<ObjectId>`
(`resolve-ref.ts`) follows symrefs; with `peel:false` keeps tag oids as roots.
`getRefStore(ctx).resolveDirect(name): { kind:'direct'|'symbolic'|'missing' }`
(`ref-store.ts`) is the raw read. Reflogs: `readReflog(ctx, ref):
Promise<ReadonlyArray<ReflogEntry>>` (`reflog-store.ts`); enumeration is the
private `collectReflogs` — reuse `enumerateRefs` + `readReflog`.

**Graph walk** — `walkCommits` / `walkCommitsByDate`
(`src/application/primitives/walk-commits*.ts`) yield `Commit` objects and follow
**parents only** (`ignoreMissing` tolerates absent parents). `walkTree(ctx,
treeIdOrObject, { recursive?: true }): AsyncIterable<WalkTreeEntry>`
(`walk-tree.ts`; `WalkTreeEntry = { path: FilePath; id: ObjectId; mode:
FileMode }`) recurses trees → sub-trees + blobs but **does not descend gitlinks
(mode 160000)** and **throws** on a corrupt/missing tree. `Tag`
(`src/domain/objects/tag.ts`): `data = { object: ObjectId; objectType:
ObjectType; tagName; tagger?; … }` — `object` is the pointed-at oid, `objectType`
the declared type (lets fsck check the target's actual type).
No full-graph reachability/closure primitive exists (only push-scoped private
`walkCommitClosure`).

## Requirements

When this ships:

1. `repo.fsck(opts?)` returns a structured `FsckResult` — a `findings` array of a
   `readonly` discriminated union + the git-faithful composite `exitCode` integer
   — and emits **no** rendered line.
2. The finding set, finding categories, and exit-code class match real `git fsck`
   for every scenario in the pinned matrix below, proven by reconstructing git's
   stdout+stderr lines from the structured fields inside the interop test
   (byte-equal vs the real binary).
3. fsck is **read-only**: it never writes to the object store, refs, reflogs, or
   any state file. (git's `--lost-found` write side is out of scope — see below.)
4. Reachability roots match git's default head set: all refs, HEAD, **reflog
   entries** (old + new oids), and the **index** (`--cache` head). The reflog and
   index root classes are independently togglable via the `reflogRoots` /
   `indexRoot` data-scope options (ADR-411).
5. A corrupt/missing/mistyped object encountered anywhere (object scan, ref
   target, or graph edge) is **caught and reported as a finding**, never thrown
   out of the command — fsck's whole job is to not crash on a broken repo.
6. Refusal conditions match git: fsck refuses **only** outside a repository (git's
   "not a git repository"). The in-repo gate is `assertRepository` (a repository
   exists — `${gitDir}/HEAD` present), **not** `assertOperationalRepository`
   (ADR-414): fsck must run on the broken repo it diagnoses, so a broken `[core]`
   config and an unborn/dangling symref (HEAD → unborn branch) are tolerated, not
   faults (clean, exit 0).

## Design

### Faithfulness matrix (pinned against real `git` 2.54.0)

Every probe ran in a `mktemp` throwaway with `env -i`, isolated `HOME`,
`GIT_CONFIG_NOSYSTEM=1`, signing off. stdout/stderr captured separately. `<sha>` =
literal 40-hex; surrounding text byte-exact.

**Stream discipline (load-bearing).** git splits findings across two streams; both
are caller rendering (ADR-249) but the routing must be reconstructable from the
fields:

- **stdout — reachability taxonomy:** `dangling <type> <sha>`, `unreachable <type>
  <sha>`, `missing <type> <sha>`, `broken link from  <type> <sha>` / (14 spaces)`to
  <type> <sha>`, `root <sha>`, `tagged <type> <sha> (<name>) in <tagobj-sha>`.
- **stderr — integrity faults & progress:** `error: <sha>: object corrupt or
  missing: <path>`, `error: unable to unpack header of <path>`, `error: inflate:
  data stream error (<detail>)`, `error: <sha>: hash-path mismatch, found at:
  <path>`, `error: <ref>: invalid sha1 pointer <sha>`, `error: <ref>: invalid
  reflog entry <sha>`, `error: <ref>: badRefContent: <value>`, `error in <type>
  <sha>: <msgId>: <message>` (ERROR content), `warning in <type> <sha>: <msgId>:
  <message>` (WARN/INFO content), `notice: …`, `Checking …` (verbose/progress).

**Byte-exact `broken link` layout** (`od -c` confirmed): line 1 = `broken link
from` + 2 spaces + `<type> <sha>\n`; line 2 = 14 spaces + `to` + 2 spaces + `<type>
<sha>\n` (object descriptor aligned at column 18).

| # | scenario | command | findings (stdout / stderr) | exit |
|---|---|---|---|---|
| 1 | healthy (3 reachable commits), stderr piped | `git fsck` | *(nothing on either stream)* | 0 |
| 1b | healthy | `--full` / `--connectivity-only` / `--no-full` | *(nothing)* | 0 |
| 1c | healthy, `--progress` forced | `git fsck --progress` | stderr `Checking ref database: 100% …` / `Checking object directories: 100% …` | 0 |
| 2 | commit orphaned by `reset --hard`, **reflog intact** | `git fsck` | *(nothing — reflog keeps it reachable)* | 0 |
| 2b | same, reflog intact | `--no-reflogs` | stdout `dangling commit <sha>` | 0 |
| 2c | reflog deleted | `git fsck` | stdout `dangling commit <sha>` | 0 |
| 3 | `hash-object -w` blob, never referenced | `git fsck` | stdout `dangling blob <sha>` | 0 |
| 4 | `git mktree` tree, unreferenced | `git fsck` | stdout `dangling tree <sha>` | 0 |
| 5 | annotated tag, ref deleted | `git fsck` | stdout `dangling tag <sha>` | 0 |
| 6 | 2-commit orphan subgraph, reflog expired | `git fsck` (default) | stdout `dangling commit <tip>` — **tip only** | 0 |
| 6b | same | `--unreachable` | stdout `unreachable {commit,tree,blob} <sha>` — **every** object | 0 |
| 7a | loose blob (in a tree) deleted | `git fsck` | stdout `missing blob <sha>` (no `broken link` for tree→blob) | **2** |
| 7b | loose parent-commit deleted | `git fsck` | stdout `broken link from  commit <child>` / `to  commit <parent>` + `dangling tree <sha>` + `missing commit <parent>`; stderr `error: <ref>: invalid reflog entry <sha>` (per affected reflog line) | **2** |
| 8a | loose object truncated / byte-flipped | `git fsck` | stdout `missing blob <sha>`; stderr `error: <sha>: object corrupt or missing: <path>` + `error: unable to unpack header …` (+ inflate detail) | **3** |
| 8b | valid object at wrong path (hash≠path) | `git fsck` | stdout `dangling blob <actual-sha>`; stderr `error: <actual-sha>: hash-path mismatch, found at: <path>` | **1** |
| 9a | ref → valid-but-absent sha | `git fsck` | stderr `error: refs/heads/broken: invalid sha1 pointer <sha>` | **2** |
| 9b | ref → malformed content | `git fsck` | stderr `error: refs/heads/garbage: badRefContent: <value>` + `… invalid sha1 pointer 0000…0` | **10** |
| 9c | HEAD → unborn branch (dangling symref) | `git fsck` | *(nothing)* | **0** |
| 10 | dangling object packed-only (`repack -ad`) | `git fsck` | stdout `dangling blob <sha>` (storage-agnostic) | 0 |
| 11a | root commits | `--root` | stdout `root <sha>` | 0 |
| 11b | tag target | `--tags` | stdout `tagged commit <sha> (v1) in <tagobj-sha>` | 0 |
| 11c | staged-only blob | `--cache` | *(nothing — index is already a default head)* | 0 |
| 12a | `zeroPaddedFilemode` tree | `git fsck` | stderr `warning in tree <sha>: zeroPaddedFilemode: contains zero-padded file modes` | **0** |
| 12b | same | `--strict` | stderr `error in tree <sha>: zeroPaddedFilemode: …` (same body, `warning`→`error`) | **1** |
| 12c | `treeNotSorted` / `missingSpaceBeforeEmail` | `git fsck` (and `--strict`) | stderr `error in <type> <sha>: <msgId>: …` (already ERROR in both) | **1** |

**Pinned rules extracted:**

- **dangling vs unreachable.** Default reports only the **tips/roots** of each
  unreachable subgraph as `dangling` (an object *directly used* by another
  unreachable object is not dangling). `--unreachable` enumerates **every**
  unreachable object as `unreachable …`. Both exit 0 — unreachability is not a
  fault.
- **Reflogs & index are default roots.** A `reset --hard`'d commit is reachable
  while its reflog survives; the index is part of the default head set
  (staged-only blob is not dangling). `--no-reflogs` / `--cache` toggle these
  root classes — **data-scope**, not rendering.
- **Storage-agnostic.** dangling/unreachable detection is identical for loose and
  packed objects.
- **Exit code is a severity bitmask** OR'd across fault classes: 0 = clean /
  dangling / unreachable / content-INFO-WARN; 1 = generic fsck error
  (`--strict` upgrade, content-ERROR, hash-path mismatch); 2 = missing / broken
  link / ref→absent-sha; 3 = corrupt/undecodable loose object; **8 = `git refs
  verify` ref-content failure** (the refs-verify pass, IN v1 per ADR-412 D1).
  Composite faults OR: `9b` (malformed ref content) = `2 | 8 = 10` — the
  badRefContent line contributes bit 8, the synthesised zero-oid pointer
  contributes bit 2. Pinned against real git 2.54.0: `9a` exit **2**, `9b` exit
  **10**, isolated `zeroPaddedFilemode` default exit **0** / `--strict` exit **1**.

**Flag classification — three classes (ADR-411 D4 fixed):** **projection** (the
maximal taxonomy is always computed; the flag is a caller-side filter of the
returned `findings`, so it is **not** a library option), **data-scope option**
(changes *what is computed/examined* or *the verdict* — kept as a `FsckOptions`
toggle), and **rendering / side-effect** (ADR-249-dropped, never on the surface).

| flag | meaning | class |
|---|---|---|
| `--unreachable` | also emit every unreachable object | **projection** (filter; not an option) |
| `--dangling` / `--no-dangling` | include/omit dangling findings (default on) | **projection** (filter; not an option) |
| `--root` | also emit root commits | **projection** (filter; not an option) |
| `--tags` | also emit tag targets | **projection** (filter; not an option) |
| `--cache` | add the index as a reachability root | data-scope option (`indexRoot`) |
| `--no-reflogs` | stop treating reflog entries as roots | data-scope option (`reflogRoots`) |
| `--full` / `--no-full` | include/exclude packs + alternates (default full) | data-scope option (`full`) |
| `--connectivity-only` | skip object-content validation; check links only | data-scope option (`connectivityOnly`) |
| `--strict` | upgrade WARN-class msg-ids to ERROR (+exit) | data-scope option (`strict`) |
| `--references` / `--no-references` | run / skip the `git refs verify` pass | data-scope option (`checkReferences`) |
| `--name-objects` | annotate findings with a rev-parse name (`(:path)`) | **rendering** (expose the name/path *field*, not the `(…)` suffix) |
| `--lost-found` | write orphans to `.git/lost-found/**` | **side-effect** (write surface — out of scope) |
| `--verbose` | `Checking <type> <sha>` trace lines | **rendering** |
| `--progress` / `--no-progress` | progress meter | **rendering** |

The maximal taxonomy (`dangling` ∪ `unreachable` ∪ `root` ∪ `tagged` ∪ all
integrity faults) is computed unconditionally; a caller reproducing `git fsck`
default output filters to `dangling` + integrity faults, `--unreachable` is the
same data unfiltered — no library code path differs (ADR-411). The six kept
options are the genuine computation/verdict knobs.

### Object-content msg-id catalogue (pinned against real `git` 2.54.0)

ADR-412 D2 puts git's **full** named fsck msg-id catalogue in v1. The catalogue
and each id's default severity are pinned from git 2.54.0's shipped
`fsck-msgids.adoc` and cross-checked behaviourally (the `zeroPaddedFilemode` /
`treeNotSorted` / `missingSpaceBeforeEmail` rows below were triggered against the
real binary: default vs `--strict` byte-exact). The `domain/fsck/` validator
reproduces these for the four object kinds; `--strict` upgrades every **WARN**
default to **ERROR** (and the exit bit), leaving ERROR/INFO/IGNORE/FATAL ids
unchanged — byte-faithful to git's `warning in …` → `error in …` flip.

**Severity legend.** **ERROR** → `error in <type> <sha>: <msgId>: <msg>` (exit
bit 1); **WARN** → `warning in <type> <sha>: <msgId>: <msg>` (exit 0 default,
upgraded to ERROR under `--strict`); **INFO** → emitted as `warning in …` line but
never affects exit and is not strict-upgraded; **IGNORE** → silenced by default;
**FATAL** → object is undecodable (maps to tsgit's parse/`bad-object` corrupt
path, exit class 3). Refs-pass msg-ids (`badRefContent`, …) are listed for
completeness but route through the `bad-ref` finding, not `bad-object`.

**Object-validation catalogue (commit / tree / tag / blob):**

| msgId | object kind | default severity | strict |
|---|---|---|---|
| `badDate` | commit, tag (author/committer) | ERROR | — |
| `badDateOverflow` | commit, tag | ERROR | — |
| `badEmail` | commit, tag | ERROR | — |
| `badFilemode` | tree | INFO | — |
| `badGpgsig` | tag | ERROR | — |
| `badName` | commit, tag | ERROR | — |
| `badObjectSha1` | any | ERROR | — |
| `badParentSha1` | commit | ERROR | — |
| `badTagName` | tag | INFO | — |
| `badTimezone` | commit, tag | ERROR | — |
| `badTree` | tree | ERROR | — |
| `badTreeSha1` | tree | ERROR | — |
| `badType` | any | ERROR | — |
| `duplicateEntries` | tree | ERROR | — |
| `emptyName` | tree | WARN | → ERROR |
| `extraHeaderEntry` | tag | IGNORE | — |
| `fullPathname` | tree | WARN | → ERROR |
| `gitattributesBlob` | tree (`.gitattributes`) | ERROR | — |
| `gitattributesLarge` | blob | ERROR | — |
| `gitattributesLineLength` | blob | ERROR | — |
| `gitattributesMissing` | blob | ERROR | — |
| `gitattributesSymlink` | tree | INFO | — |
| `gitignoreSymlink` | tree | INFO | — |
| `gitmodulesBlob` | tree (`.gitmodules`) | ERROR | — |
| `gitmodulesLarge` | blob | ERROR | — |
| `gitmodulesMissing` | blob | ERROR | — |
| `gitmodulesName` | blob | ERROR | — |
| `gitmodulesParse` | blob | INFO | — |
| `gitmodulesPath` | blob | ERROR | — |
| `gitmodulesSymlink` | tree | ERROR | — |
| `gitmodulesUpdate` | blob | ERROR | — |
| `gitmodulesUrl` | blob | ERROR | — |
| `hasDot` | tree | WARN | → ERROR |
| `hasDotdot` | tree | WARN | → ERROR |
| `hasDotgit` | tree | WARN | → ERROR |
| `largePathname` | tree | WARN | → ERROR |
| `mailmapSymlink` | tree | INFO | — |
| `missingAuthor` | commit | ERROR | — |
| `missingCommitter` | commit | ERROR | — |
| `missingEmail` | commit, tag | ERROR | — |
| `missingNameBeforeEmail` | commit, tag | ERROR | — |
| `missingObject` | tag | ERROR | — |
| `missingSpaceBeforeDate` | commit, tag | ERROR | — |
| `missingSpaceBeforeEmail` | commit, tag | ERROR | — |
| `missingTag` | tag | ERROR | — |
| `missingTagEntry` | tag | ERROR | — |
| `missingTaggerEntry` | tag | INFO | — |
| `missingTree` | commit | ERROR | — |
| `missingType` | tag | ERROR | — |
| `missingTypeEntry` | tag | ERROR | — |
| `multipleAuthors` | commit | ERROR | — |
| `nulInCommit` | commit | WARN | → ERROR |
| `nulInHeader` | any | FATAL | — |
| `nullSha1` | tree | WARN | → ERROR |
| `treeNotSorted` | tree | ERROR | — |
| `unknownType` | any | ERROR | — |
| `unterminatedHeader` | any | FATAL | — |
| `zeroPaddedDate` | commit, tag | ERROR | — |
| `zeroPaddedFilemode` | tree | WARN | → ERROR |

**Refs-pass catalogue (routed through `bad-ref`, ADR-412 D1 — the `git refs
verify` pass):**

| msgId | default severity | exit bit | note |
|---|---|---|---|
| `badRefContent` | ERROR | 8 (refs pass) | malformed loose-ref content; pinned `9b` composite = `2\|8 = 10` |
| `badRefName` | ERROR | 8 | invalid ref name format |
| `badRefOid` / *invalid sha1 pointer* | ERROR | 2 | ref → syntactically-valid but absent/zero oid (pinned `9a` exit 2) |
| `badRefFiletype` | ERROR | 8 | ref has a bad file type |
| `badReferentName` | ERROR | 8 | symref referent name invalid |
| `badHeadTarget` | ERROR | 8 | `HEAD` symref does not refer to a branch |
| `emptyPackedRefsFile` | INFO | 0 | empty `packed-refs` |
| `packedRefEntryNotTerminated` | ERROR | 8 | `packed-refs` entry not newline-terminated |
| `packedRefUnsorted` | ERROR | 8 | `packed-refs` not sorted |
| `refMissingNewline` | INFO | 0 | loose ref without trailing LF |
| `trailingRefContent` | INFO | 0 | loose ref with trailing content |
| `symlinkRef` | INFO | 0 | symlink used as a symref |
| `symrefTargetIsNotARef` | INFO | 0 | symref target outside `refs/` |

The **strict-upgrade set** is exactly the WARN-default rows above: `emptyName`,
`fullPathname`, `hasDot`, `hasDotdot`, `hasDotgit`, `largePathname`, `nulInCommit`,
`nullSha1`, `zeroPaddedFilemode`. INFO/IGNORE/FATAL/ERROR ids are *not* upgraded by
`--strict` (pinned: `treeNotSorted` and `missingSpaceBeforeEmail` are ERROR in both
default and strict; `zeroPaddedFilemode` flips WARN→ERROR).

### Architecture

Hexagonal, Tier-1 command composed from existing read primitives, one net-new
public Tier-2 primitive (`enumerateObjects`, ADR-413), one net-new `domain/fsck/`
validator module (the msg-id catalogue, ADR-412), and an inline closure. The
command never throws on a broken repo — every primitive call that can fault is
wrapped to a finding.

**Pipeline (`fsck(ctx, opts)`):**

1. `assertRepository(ctx)` — refuse **only** outside a repository (ADR-414); a
   broken `[core]` config and an unborn/dangling HEAD symref are tolerated (matrix
   #9c). Not `assertOperationalRepository`.
2. **Enumerate all objects** via the `enumerateObjects` primitive — loose (walk
   `objects/<2hex>/<38hex>`) ∪ packed (every oid from the pack-index all-oid
   iterator over `PackRegistry.all()`). Produces the universe `A`.
3. **Validate each object** (skipped under `--connectivity-only`): `readObject(id,
   { verifyHash: true })` for the structural faults — `OBJECT_HASH_MISMATCH` →
   `hash-mismatch`, parse/header codes → `bad-object` (corrupt), inflate/IO →
   `bad-object` (corrupt, exit class 3) — **then** run the `domain/fsck/`
   validator over the parsed object for git's named msg-id catalogue
   (`treeNotSorted`, `zeroPaddedFilemode`, `missingSpaceBeforeEmail`, …), emitting
   one `bad-object` per failed check carrying `msgId` + `severity`. `--strict`
   upgrades the WARN-class ids to ERROR (and the exit bit). A readable object's
   parsed shape feeds the graph edges in step 5.
4. **Collect roots** `R`: refs (`enumerateRefs` → `resolveRef(peel:false)`), HEAD,
   reflog old+new oids (unless `reflogRoots:false`), index oids (when `indexRoot` /
   default-on). When `checkReferences` (default-on, the `git refs verify` pass): a
   root resolving to an absent/zero oid → `bad-ref` (`invalid sha1 pointer`, exit
   bit 2); malformed ref content → `bad-ref` (`badRefContent`, exit bit 8) — the
   two compose to exit 10 (matrix #9b). `checkReferences:false` skips the
   ref-content verification.
5. **Reachability closure** (inline, ADR-413) from `R`: BFS following
   commit→tree+parents, tree→sub-trees+blobs (`walkTree`, gitlinks not descended),
   tag→object. An edge to an absent oid → `missing` (+ a `broken-link` finding
   carrying the referrer+referent, matrix #7b); an edge to a mistyped object →
   `bad-object`. Yields the reachable set `Reach`.
6. **Classify** against `A` (the maximal taxonomy, always computed — ADR-411):
   `unreachable` = `A − Reach`; `dangling` = the unreachable objects with no
   in-edge from another present object (the subgraph tips); `root` and `tagged`
   projections. All are emitted as findings; the caller filters for git-CLI parity
   (no `--unreachable`/`--root`/`--tags` option exists).
7. **Compose the exit code** as the OR of the severity bits each finding class
   contributes (the pinned bitmask, incl. bit 8 for the refs-verify pass).

**New composition vs reuse:**

- **Reuse:** `readObject`, `enumerateRefs`, `resolveRef`/`getRefStore`,
  `readReflog`, `walkTree`, `Tag`/`Commit`/`Tree` parsers, `path-layout` helpers,
  `getPackRegistry`.
- **Net-new (ADR-412 / ADR-413):**
  - **`enumerateObjects`** — a public Tier-2 primitive in `application/primitives/`
    (loose scan ∪ pack-index all-oid iterator), reusable by future
    `gc`/`prune`/`repack`/`bundle` (ADR-413 D6). Requires the small all-oid
    iterator addition to `domain/storage/pack-index.ts`.
  - **`domain/fsck/` validator module** — git's named msg-id catalogue per object
    kind + the severity table + the strict-upgrade map (ADR-412 D2). This is the
    bulk of the implementation weight.
  - **Reachability closure + dangling/unreachable classification** — stays
    **inline** in `commands/fsck.ts` (an internal helper module if needed); it is
    fsck-specific verdict logic, promoted to a primitive only when a real second
    consumer lands (ADR-413 D6, YAGNI). Computed by set-difference: `unreachable =
    A − Reach`, `dangling` = unreachable objects with no in-edge (ADR-413 D5).

### Public surface

`FsckOptions` is **fixed by ADR-411 (D4)** to exactly the six genuine
computation/verdict toggles. The maximal finding taxonomy is always computed; the
projection flags (`--unreachable`, `--dangling`, `--root`, `--tags`) are NOT
options — the caller filters the returned `findings`.

```ts
repo.fsck(opts?: FsckOptions): Promise<FsckResult>;

interface FsckOptions {
  readonly connectivityOnly?: boolean;   // --connectivity-only: skip object-content validation, check links only
  readonly reflogRoots?: boolean;        // --no-reflogs ⇒ false (default true): reflog oids as roots
  readonly indexRoot?: boolean;          // --cache ⇒ true; default true (git's default head set): index oids as roots
  readonly full?: boolean;               // --no-full ⇒ false (default true): include packs (alternates out of scope)
  readonly strict?: boolean;             // --strict: WARN-class msg-ids → ERROR (+exit bit)
  readonly checkReferences?: boolean;    // --no-references ⇒ false (default true): the `git refs verify` ref-content pass
}

interface FsckResult {
  readonly findings: ReadonlyArray<FsckFinding>;
  readonly exitCode: number;             // git's composite severity bitmask (0/1/2/3/8/10 and their ORs; bit 8 = refs-verify pass)
}
```

`FsckFinding` is a flat `readonly` discriminated union on `type` (ADR-411 D3),
mirroring `domain/diff/diff-change.ts` — one interface per variant, each
self-describing, branded `ObjectId`/`RefName` fields:

```ts
type FsckObjectType = 'commit' | 'blob' | 'tree' | 'tag';
type FsckSeverity = 'error' | 'warning' | 'info';   // git's WARN/ERROR/INFO classes

type FsckFinding =
  | { readonly type: 'dangling';     readonly objectType: FsckObjectType; readonly id: ObjectId }
  | { readonly type: 'unreachable';  readonly objectType: FsckObjectType; readonly id: ObjectId }
  | { readonly type: 'missing';      readonly objectType: FsckObjectType; readonly id: ObjectId; readonly referencedBy?: ObjectId }
  | { readonly type: 'broken-link';  readonly from: ObjectId; readonly fromType: FsckObjectType; readonly to: ObjectId; readonly toType: FsckObjectType }
  | { readonly type: 'bad-object';   readonly id: ObjectId; readonly objectType: FsckObjectType; readonly msgId: string; readonly severity: FsckSeverity }
  | { readonly type: 'hash-mismatch'; readonly id: ObjectId; readonly actual: ObjectId }
  | { readonly type: 'bad-ref';      readonly ref: RefName; readonly msgId: string; readonly severity: FsckSeverity; readonly target?: ObjectId }
  | { readonly type: 'root';         readonly id: ObjectId }
  | { readonly type: 'tagged';       readonly id: ObjectId; readonly objectType: FsckObjectType; readonly tagName: string; readonly tag: ObjectId };
```

`bad-object` carries `msgId` (git's catalogue id — `treeNotSorted`,
`zeroPaddedFilemode`, …) + the post-`--strict` `severity`; the caller reconstructs
git's `error in <type> <sha>: <msgId>: <msg>` / `warning in …` line from these
fields. `bad-ref` carries the refs-pass `msgId` (`badRefContent`, *invalid sha1
pointer*, …) + `severity` for the `error: <ref>: <msgId>: …` stderr line.
Branded types reused from `src/domain/objects/object-id.ts` (`ObjectId`,
`RefName`). The union discriminates on `type` (object/diff-graph precedent), not
`kind` (state-union precedent). Stream routing (stdout taxonomy vs stderr faults)
is reconstructed from the variant at render time, never encoded as two arrays
(ADR-411).

### Refusal & error semantics

- **Non-repository is the only refusal:** `assertRepository(ctx)` (ADR-414) —
  asserts `${gitDir}/HEAD` exists, throws `notARepository` outside a repo. Unlike
  `log`, fsck does **not** gate on `assertOperationalRepository`: a broken `[core]`
  config and an unborn/dangling HEAD symref are tolerated, because fsck must run on
  exactly the corrupt repo a user points it at. `assertRepository` and
  `assertOperationalRepository` both live in
  `src/application/primitives/internal/repo-state.ts`; the latter adds
  `assertCoreConfigValid`, which fsck deliberately skips.
- **In-repo faults are findings, never throws.** Every `readObject` /
  `walkTree` / `resolveRef` call inside the scan/closure is wrapped: a thrown
  `TsgitError` is classified to a finding by its `.data.code`. fsck must survive
  the worst repo it is pointed at.
- **Exit code, not exception, carries severity.** A repo with missing/corrupt
  objects returns a non-zero `exitCode` in a successfully-resolved `FsckResult` —
  it does **not** reject. (git exits non-zero but still prints all findings; the
  structured analogue is a populated `findings` + composite `exitCode`.)

## Decisions (ratified — ADRs 411–414)

All seven design decisions are resolved by the ADR set. D3/D4 adopted the
designer recommendation; D1/D2 ratified the **fuller** scope (overriding the
designer's deferral); D5 adopted-as-recommended; D6/D7 user-ratified.

| # | Decision | Resolution | ADR |
|---|---|---|---|
| D1 | v1 check scope | **Full** — the `git refs verify` ref-content pass is IN v1: `badRefContent` findings, exit-bit 8 (composite 10), `checkReferences` option live. | 412 |
| D2 | Content-validation depth | **Full** — git's complete named msg-id catalogue (pinned above) in a net-new `domain/fsck/` validator, faithful msg-ids + the WARN/ERROR/INFO severity table, `--strict` WARN→ERROR upgrade ships now. | 412 |
| D3 | `FsckFinding` shape | **Flat discriminated union on `type`** (one interface per variant, `diff-change.ts` precedent); stream routing is caller rendering, never a two-array split. | 411 |
| D4 | Flags → options | **Compute the maximal taxonomy always; caller filters projections.** Final `FsckOptions` = the six genuine toggles (`connectivityOnly`, `reflogRoots`, `indexRoot`, `full`, `strict`, `checkReferences`); `--unreachable`/`--dangling`/`--root`/`--tags` dropped as options. | 411 |
| D5 | Dangling/unreachable strategy | **Set-difference closure** — `unreachable = A − Reach`; `dangling` = unreachable objects with no in-edge from another present object (the subgraph tips), faithful to the pinned tip-vs-all distinction (#6). | 413 |
| D6 | Primitive vs inline | **`enumerateObjects` ships as a public Tier-2 primitive** (reusable by future `gc`/`prune`/`repack`/`bundle`); the reachability closure stays **inline** in `commands/fsck.ts` until a second consumer lands (YAGNI). The pack-index all-oid iterator is the small `pack-index.ts` addition. | 413 |
| D7 | Repository-state gate | **`assertRepository` only** (repo exists), NOT `assertOperationalRepository`: fsck must run on the broken repo it diagnoses, tolerating a broken `[core]` config and an unborn/dangling HEAD symref. Refuses only outside a repository. | 414 |

## Test strategy

- **Unit** (`fsck.test.ts`, memory adapter): GWT/AAA, `sut = fsck`, 100%
  line/branch/function + 0 surviving mutants. One isolated test per finding class
  and per guard (mutation-resistant): healthy repo → empty findings + exit 0;
  dangling commit/blob/tree/tag (tip-only); the always-computed `unreachable`
  taxonomy enumerates the whole orphan subgraph (caller filters, no option);
  missing blob referenced by a tree (#7a, exit 2); missing parent commit →
  `broken-link` + `missing` (#7b); corrupt loose object → `bad-object` (exit 3);
  hash-path mismatch → `hash-mismatch`/`dangling` (exit 1); reflog-kept-reachable
  vs `reflogRoots:false`; index root vs `indexRoot`; `connectivityOnly` suppresses
  content faults; `root`/`tagged` projections; packed-only dangling object (#10);
  unborn-HEAD-symref is clean (#9c); broken-`[core]`-config repo is **not** refused
  (ADR-414); non-repository refuses (`notARepository`).
  - **msg-id catalogue** (per-msgId cases over the `domain/fsck/` validator):
    `treeNotSorted` (ERROR), `zeroPaddedFilemode` (WARN), `missingSpaceBeforeEmail`
    (ERROR), plus a representative case per object kind from the pinned table; each
    asserts the emitted `bad-object`'s `msgId` + `severity` on its `.data`.
  - **`--strict` upgrade** (isolated, both guard arms): a WARN-default id
    (`zeroPaddedFilemode`) flips to `severity:'error'` + sets exit bit 1 under
    `strict:true`; an already-ERROR id (`treeNotSorted`) and an INFO id are
    **unchanged** by `strict` (the upgrade set is exactly the WARN rows).
  - **refs-verify pass** (`checkReferences`): ref → absent/zero sha → `bad-ref`
    (*invalid sha1 pointer*, exit bit 2, #9a); malformed ref content → `bad-ref`
    (`badRefContent`, exit bit 8) composing to exit 10 (#9b); `checkReferences:false`
    skips the ref-content verification.
  - Each exit-code bit asserted on its **`.data`** (specific `msgId`/`severity`,
    never `toThrow(Class)` alone).
- **Properties** (`fsck.properties.test.ts`, lens 2 — compositional aggregator):
  over an arbitrary small object graph — *closure invariants*: an object reachable
  from a root is never `dangling`/`unreachable`/`missing`; adding a root that
  reaches an object flips it out of `unreachable`; `dangling ⊆ unreachable`;
  `unreachable ∩ Reach = ∅`; a present object directly used by another present
  object is never `dangling`. (`numRuns` 100.) The `enumerateObjects` primitive
  gets a round-trip property (lens 1): every written oid (loose ∪ packed) is
  enumerated exactly once, in `enumerateObjects.properties.test.ts`.
- **Interop** (`test/integration/fsck-interop.test.ts`, real-git twin via
  `interop-helpers.ts`'s scrubbed `runGit`): one tmp repo per matrix scenario;
  hand-corrupt objects/refs in the tmp `.git`, run `repo.fsck()`, **reconstruct
  git's exact stdout + stderr lines and stream routing from the structured
  fields**, and assert byte-equality with `git fsck <flags>` plus the exact exit
  code. Covers the dangling/unreachable, missing/broken-link, corrupt,
  hash-mismatch, bad-ref, root/tagged, and packed-only cases — **plus** the
  scope-fold additions: `badRefContent`/exit-10 (#9b) and the `invalid sha1
  pointer`/exit-2 (#9a) refs-verify cases; the msg-id catalogue
  (`zeroPaddedFilemode` default `warning in tree …` exit 0 / #12a,
  `--strict` `error in tree …` exit 1 / #12b, `treeNotSorted` +
  `missingSpaceBeforeEmail` ERROR in both / #12c), each loose object hand-written
  past git's write-side fsck so the read-side severity is observed.
- **Parity scenario** (`test/parity/scenarios/fsck.scenario.ts` + `index.ts`
  registration): a small repo with one dangling + one missing object asserting the
  same structured `findings`/`exitCode` on node / memory / browser.

## Surface gates (per the Tier-1 checklist)

- `src/application/commands/fsck.ts` + barrel export in
  `src/application/commands/index.ts` (alphabetical: after the `fetch`/`fetch-missing`
  block, before `grep`) → public via `src/index.ts`'s `export *`.
- `src/repository.ts`: `readonly fsck: BindCtx<typeof commands.fsck>;` on the
  `Repository` interface + the `guard(); return commands.fsck(ctx, opts);` binding
  (both alphabetical, after `fetchMissing`, before `grep`). Flat `BindCtx<…>` line
  (the doc-coverage parser keys off it).
- `test/unit/repository/repository.test.ts` (~line 199): add `'fsck'` to the
  facade key-set array (between `'fetchMissing'` and `'grep'`).
- `docs/use/commands/fsck.md` + a `` [`fsck`](fsck.md) `` row in
  `docs/use/commands/README.md` (doc-coverage gate, `tooling/check-doc-coverage.ts`).
- `README.md` (~line 46): bump the Tier-1 command count `39` → `40`.
- `src/application/primitives/enumerate-objects.ts` (new public Tier-2 primitive,
  ADR-413) + barrel export in `src/application/primitives/index.ts` → public via
  `src/index.ts`. It enters `reports/api.json` and the Tier-2 primitive list
  alongside `fsck`. (The reachability closure stays inline in `commands/fsck.ts` —
  not a public surface entry, ADR-413 D6.)
- `reports/api.json`: regenerate (new public `fsck` + `FsckOptions` /
  `FsckResult` / `FsckFinding`, **and** `enumerateObjects` + its options/return
  types) — prepush `check:doc-typedoc` gate; large typedoc-id churn is expected.
- `docs/BACKLOG.md`: flip `24.3` to `[x]` (docs phase).

## Out of scope

Per ADR-412, v1 covers git's **full** finding space (object-content msg-id
catalogue + `--strict`, connectivity, and the refs-verify pass); out of scope
narrows to:

- **`--lost-found` write side** — materialising orphans under `.git/lost-found/**`
  is a write surface; fsck stays read-only. (git-faithful divergence: we report the
  same orphans, we don't write them.)
- **`--name-objects` / `--verbose` / `--progress`** — pure rendering (ADR-249);
  the library exposes the underlying path/name *field*, not the `(…)` suffix or
  trace text.
- **Alternates / `--full` over alternate object stores** — tsgit has no alternates
  mechanism; `--full` covers this repo's packs only.
- **Gitlink (submodule) target verification** — `walkTree` does not descend mode
  160000; submodule object integrity belongs to the submodule's own repo (matches
  git, which does not follow gitlinks in fsck).
