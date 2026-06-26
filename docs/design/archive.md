# Design — `archive` (export a tree)

> Brief: Ship the Tier-1 `archive` command — git's `git archive`: export a tree-ish
> as a structured **tree→entry stream** (per entry: path, raw git mode, oid, blob
> bytes). The tar/zip byte framing is a thin, *separable* serializer — a
> data-interchange format (ADR-249), not human display — kept isolated so a consumer
> can swap in its own container. Rendering concerns (prefix, compression level,
> mtime, mode-umask) are **not** baked into the data surface.
> Status: draft → self-reviewed ×3 → accepted → revised to ADRs 415–419 (zip folded into scope; raw-DEFLATE port capability)

## Context

`archive` is backlog **24.4**. It is a pure read use-case: resolve a tree-ish,
walk its tree, and surface the entries a `git archive` would frame. No
structurally-invasive layout change; it composes existing read primitives.

Constraints it inherits:

- **Prime directive (ADR-226):** replicate git's observable DATA and on-disk
  behaviour byte-for-byte. `archive` reads only; its faithfulness surface is *which
  entries it emits, in what order, with which oids/modes*, plus *the resolved commit
  oid + committer time* (the metadata git stamps into a tar pax global header / zip
  comment), plus *the refusal conditions* — all pinned empirically below and frozen
  by an interop test.
- **Structured-output (ADR-249):** the library emits **data** (paths, modes, oids,
  blob bytes, the resolved commit oid + timestamp); *representing* it — the `--prefix`
  string, the compression level, the mtime, the tar `umask`-masked mode bits — is the
  **caller's** job. Per ADR-249 a command surface "must not … return a pre-rendered
  line/`bytes`": therefore the `archive` **command** returns the structured entry
  stream and never tar/zip bytes. The tar/zip framing is a distinct, isolated,
  swappable serializer function — the brief's "a consumer can swap in its own
  container". `describe` (ADR-249) is the precedent: ship the fields, let the consumer
  format.
- **Hexagonal tiers:** `repository → commands → primitives → domain`. `archive` is a
  Tier-1 command built from Tier-2 primitives — the same blocks a library user gets.
- **Blob streaming (ADRs 383–394):** blob bytes can be arbitrarily large; the snapshot
  surface streams them rather than buffering whole trees. The entry surface must be
  lazy (an `AsyncIterable`), not an eagerly-materialised array of `Uint8Array`s.

Prior structured-read commands set the shape: `fsck` (`docs/design/fsck.md`),
`whatchanged`, and `shortlog` — `ctx` first, one readonly options object, a structured
result, no rendered strings, the same Tier-1 surface-gate checklist.

### Pre-chewed substrate (exact paths / symbols / signatures)

**Tree walk (the entry sequence)** — `src/application/primitives/walk-tree.ts`
- `walkTree(ctx, treeIdOrObject: ObjectId | Tree, options?: WalkTreeOptions):
  AsyncIterable<WalkTreeEntry>`; `WalkTreeEntry = { path: FilePath; id: ObjectId;
  mode: FileMode }` (`primitives/types.ts`). Options `{ recursive?=true, maxDepth?=1024,
  maxEntries? }`. Cycle/depth/entry guards already present.
- **Correction to the brief's pre-chew:** `walkTree` does **not** skip directory
  entries. Its loop `yield`s **every** tree entry (line 69) — including directory
  (mode `40000`) and gitlink (mode `160000`) entries — *then* recurses into
  directories. (`flattenTree`, by contrast, filters `FILE_MODE.DIRECTORY` at
  `flatten-tree.ts:26`; that is the one that drops dirs, not `walkTree`.) Because the
  parsed `Tree.entries` preserve git's canonical on-disk sort, `walkTree`'s pre-order
  (`dir/` then its contents) is **byte-identical to git archive's emitted entry set
  and order** (pinned below). The only thing it lacks is blob bytes.
- It does **not** descend gitlinks (mode `160000` is not a directory → not recursed);
  it yields the gitlink entry itself. This matches git archive, which emits a gitlink
  as an empty directory entry and does not recurse into the submodule.

**Blob bytes** — `src/application/primitives/read-blob.ts`: `readBlob(ctx, id,
opts?): Promise<Blob>`, `Blob = { type:'blob', id, content: Uint8Array }`. A symlink
entry (mode `120000`) is a blob whose content *is* the link target bytes.

**Rev resolution** — `src/application/commands/internal/resolve-rev.ts`:
`resolveTreeish(ctx, rev)` = `peel(revParse(rev), 'tree')` (peels tags→commits→trees).
But `archive` also needs the *commit* oid + its committer time when the rev reaches a
commit (for the tar pax header / zip comment / mtime). `resolveTreeish` discards that,
so `archive` resolves with `revParse` + `readObject` + an inline classify (commit →
{commit, commitTime, tree}; tag → peel to commit; tree → bare {tree}; blob → refuse).

**Domain modes** — `src/domain/objects/file-mode.ts`: `FILE_MODE = { REGULAR:'100644',
EXECUTABLE:'100755', SYMLINK:'120000', DIRECTORY:'40000', GITLINK:'160000' }`,
`isDirectory(mode)`. The entry stream carries the **raw** git mode; serializer-side
normalisation (tar umask, zip raw) is rendering.

**Binary-framing precedent** — `src/domain/objects/tree.ts:serializeTreeContent` and
`src/application/primitives/build-pack.ts:buildPack` show `Uint8Array` assembly with
offsets. `src/domain/storage/crc32.ts:crc32(data): number` already exists (used by
`fetch-pack.ts`) — reused by the zip serializer's CRC fields.

**Compressor port** — `src/ports/compressor.ts` (reached via `src/ports/context.ts` as
`ctx.compressor`). `ctx.compressor.deflate(data, level?)` emits **zlib (RFC 1950)** —
2-byte header + adler32 trailer. zip method 8 needs **raw DEFLATE (RFC 1951)** — no zlib
wrapper — plus a CRC32; both are already reachable with **zero new dependencies and no
browser shim** (ADR-417). node's `src/adapters/node/node-compressor.ts` imports
`node:zlib`, which also exposes `deflateRawSync` (mirror the existing `deflate` level
handling at `node-compressor.ts:33`); the browser
(`src/adapters/browser/browser-compressor.ts:20`) and memory
(`src/adapters/memory/memory-compressor.ts:23`) compressors use the Web
`CompressionStream`, which accepts `'deflate-raw'` the same way they already call
`'deflate'`; and `src/domain/storage/crc32.ts:crc32(data): number` is in-tree (used by
`fetch-pack`). So zip ships in v1 behind one **additive** port method —
`deflateRaw(data, level?): Promise<Uint8Array>` — with node/browser/memory
implementations; `deflate` is untouched, and tar needs no compression at all. (This
retires the old "defer zip" asymmetry — see DC2 / ADR-417.)

**Tier-1 surface gates** (mirror `fsck`): barrel `src/application/commands/index.ts`
(alphabetical — `archive` between `add` and `blame`); facade `src/repository.ts`
(`readonly archive: BindCtx<typeof commands.archive>` at ~L170 + the
`guard(); return commands.archive(ctx, opts);` factory binding at ~L495, both between
`add` and `blame`); `test/unit/repository/repository.test.ts` key-set; `docs/use/
commands/archive.md` + a row in `docs/use/commands/README.md`; `README.md` count `40
→ 41`; `reports/api.json` regenerate (prepush `check:doc-typedoc`); `test/parity/
scenarios/archive.scenario.ts` + registration; `docs/BACKLOG.md` `24.4 → [x]`. The
**tar + zip serializers + `ArchiveEntry`** are *also* public (the swap-point, DC4 /
ADR-418): barrel exports through `domain/archive/` (`tar.ts`, `zip.ts`) → `src/index.ts`,
entering `reports/api.json` and the docs alongside `archive` (so a consumer can frame
their own `ArchiveEntry` stream in either container). Separately, the **`deflateRaw`
port capability** (ADR-417) adds a method to the `Compressor` interface
(`src/ports/compressor.ts`) + its node/browser/memory implementations + every
`Compressor` test double, each with its own unit test — additive, `deflate` untouched.

## Requirements

When this ships:

1. `repo.archive(opts)` resolves a **required** tree-ish and returns a structured
   `ArchiveResult` (ADR-415) carrying (a) the resolved `tree` oid, (b) the peeled
   `commit` oid + `commitTime` when the rev reaches a commit (both `undefined` for a
   bare tree), and (c) `entries`: an `AsyncIterable<ArchiveEntry>` of
   `{ path, mode, oid, content? }`. It returns **no** tar/zip bytes (ADR-249).
2. The `entries` sequence — paths, **raw git modes**, oids, the presence/absence of
   `content`, the inclusion of directory and gitlink entries, and the order — matches
   exactly what `git archive` frames for the same tree-ish, proven by reconstructing
   git's **tar and zip** bytes from the structured fields inside the interop test
   (byte-equal vs the real binary).
3. The tar serializer (ADR-416/418) is an **isolated, pure, zero-dep, swappable**
   function that consumes an `ArchiveEntry` stream + caller-supplied rendering inputs
   (`prefix`, `mtime`, `umask`, `uname`/`gname`) and yields `AsyncIterable<Uint8Array>`
   whose bytes equal `git archive --format=tar` (default `umask` `0o0002`,
   `uname`/`gname` `root`, `mtime` = `commitTime`).
4. The zip serializer (ADR-417/418) is an **isolated, swappable** function **pure over
   an injected `deflateRaw` callback** (reusing in-tree `crc32`), consuming the same
   `ArchiveEntry` stream + caller-supplied rendering inputs (`prefix`, `mtime`,
   `tzOffsetMinutes`, `level`) and yielding `AsyncIterable<Uint8Array>` whose bytes
   equal `git archive --format=zip` per matrix **Z** (node adapter byte-exact including
   method-8; cross-adapter structural — see the byte-identity contract in **Z**).
5. The `Compressor` port gains `deflateRaw(data, level?): Promise<Uint8Array>` (raw
   DEFLATE, RFC 1951) — **additive**, with node (`node:zlib` `deflateRawSync`), browser
   and memory (`CompressionStream('deflate-raw')`) implementations; existing `deflate`
   is untouched (ADR-417).
6. `archive` is **read-only**: it never writes objects, refs, or any state file.
7. Refusal conditions match git (pinned matrix R1–R4; gate ADR-419): outside a
   repository → `assertRepository`'s `notARepository`; unresolvable / unborn-HEAD rev →
   the rev-vocabulary error (git `fatal: not a valid object name`); a tree-ish that
   resolves to a **blob** → refuse (git `fatal: not a tree object: <sha>`). Refusals are
   thrown, faithfully; a successful resolve never throws mid-stream for a healthy tree.
8. The entry stream is **lazy** (blob bytes hydrated per entry as iterated), honouring
   the blob-streaming direction (ADRs 383–394) — no whole-tree buffering.

## Design

### Faithfulness matrix (pinned against real `git` 2.54.0)

Every probe ran in a `mktemp -d` throwaway with scrubbed `GIT_*`, isolated `HOME`,
`GIT_CONFIG_NOSYSTEM=1`, signing off, committer date fixed to
`2005-04-07T22:13:13 +0200` (epoch `1112904793`). Headers decoded byte-exact with a
Python `struct` reader (`od -c` cross-checked).

**E — entry set, order, modes (tar, `git archive HEAD` over a tree with a regular
file, an exec file, a symlink, a nested dir, a gitlink):**

| field | pinned value |
|---|---|
| order | git canonical tree sort, **pre-order**: `a.txt`, `dir/`, `dir/m.txt`, `link`, `run.sh` — directory entry emitted *before* its contents. Identical to `walkTree` pre-order (same on-disk tree byte order). |
| directory entry | **emitted**: typeflag `5`, name has trailing `/`, size 0, no data block. |
| gitlink (160000) | **emitted as an empty directory**: typeflag `5`, `mysub/`, size 0; submodule **not** recursed (its objects are not in this repo). |
| regular file | typeflag `0`, content in 512-padded data blocks. |
| symlink (120000) | typeflag `2`, size 0, **link target in the `linkname` field** (not a data block). |

**M — tar mode mapping (THE load-bearing surprise).** git archive does **not** emit
`0644`/`0755`. It applies `tar.umask` (config, **default `0o0002`**, a fixed value —
*not* the process umask) to base modes:

| git mode | base | tar mode (default umask `0002`) | typeflag |
|---|---|---|---|
| `100644` regular | `0666` | `0664` | `0` |
| `100755` exec | `0777` | `0775` | `0` |
| `40000` directory | `0777` | `0775` | `5` |
| `160000` gitlink | `0777` | `0775` | `5` |
| `120000` symlink | `0777` (umask **not** applied to symlinks) | `0777` | `2` |

(git: regular → `mode | ((mode & 0100) ? 0777 : 0666)`, dir/gitlink → `mode | 0777`,
both `& ~tar_umask`; symlink → `mode | 0777` un-masked. Confirmed: regular `0000664`,
exec `0000775`, dir `0000775`, symlink `0000777`.) The entry stream carries the **raw**
git mode; this masking is the **tar serializer's** job and `umask` is a serializer
parameter defaulting to `0o0002`.

**T — tar header (ustar) constants:** `magic` `ustar\0`, `version` `00`,
`uname`/`gname` = `root`, `uid`/`gid` `0`, `mtime` = octal of `commitTime` (all
entries), `chksum` = unsigned byte-sum of the 512-byte header with the chksum field
filled with 8 spaces (verified `5137 == 5137`). Paths ≤100 bytes use the `name` field;
100–255 bytes split into the ustar `prefix` field at a `/`; only >255 bytes need a pax
`x` extended header (`path=` record) — an implementation edge, not a v1 blocker.
**Pinned split rule (git 2.54.0):** the split picks the rightmost `/` that yields a non-empty name (1 ≤ nameLen ≤ 100); git never emits an empty `name` field — a directory path ending with `/` splits at the slash *before* the last component, not at the trailing slash.

**P — pax global header (commit metadata, tar):** present **only** when the tree-ish
resolves to a commit (annotated tag → its peeled commit). First 512-block: name
`pax_global_header`, typeflag `g`, mode `0666`, size `52`, mtime `commitTime`, magic
`ustar\0`, uname/gname `root`; the next block carries the pax record
`52 comment=<40-hex-commit-oid>\n` (the `52` is the total record length incl. its own
count prefix and the `\n`). **The comment carries the peeled commit oid, never the tag
oid** (`git archive v1` → `comment=<commit>`). A **bare tree** archive has **no**
pax global header (first block is the first file entry) and mtime = git's *current*
time (non-deterministic → caller must supply `mtime` for byte-parity).

**D — tar EOF/padding:** ≥2 zero blocks (1024 B) EOF marker, then total padded to a
multiple of **10240** (git RECORDSIZE 512 × BLOCKING 20). Empty tree → 10240 B of
zeros; the 5-entry commit archive → 5120 B content + zeros to 10240.

**Z — zip (`git archive --format=zip <treeish>`), implementation-complete.** Pinned
against git 2.54.0 over a 7-entry tree (regular text, exec, symlink, nested dir,
gitlink, a 20 000-byte compressible blob `big.txt`, a `.gitmodules`), plus a binary blob
(NUL byte), a bare-tree run, and a `--prefix=pre/` run; every field below decoded
byte-exact from the emitted archive.

_Per-entry framing (every entry):_

| field | pinned value |
|---|---|
| local file header | sig `PK\x03\x04`, 30-byte fixed header, then name, then a 9-byte extra; **no data descriptor** — general-purpose flag bit-3 is `0`, so CRC-32 + compressed + uncompressed sizes are written in the local header up front (git has the whole blob) |
| version-needed-to-extract | `10` (zip 1.0) — local **and** central, every entry |
| general-purpose flags | `0x0000` |
| DOS mod-time / mod-date | `mtime` broken down in the **machine-local TZ** (see DOS-time note) — UTC ⇒ `time=0xa1a6 date=0x3287`, `+0200` ⇒ `0xb1a6/0x3287`, `+0530` ⇒ next-day `0x0d66/0x3288` |
| extra `UT` (local & central, byte-identical 9 bytes) | `55 54 05 00 01 <mtime LE32>` = id `0x5455`, size `5`, flag `0x01` (mod-time only, no atime/ctime), 4-byte little-endian unix `mtime` = `commitTime` (e.g. `1112904793` → `59 94 55 42`) |
| CRC-32 | CRC-32 of the **uncompressed** content (in-tree `crc32`); `0` for dir/gitlink |

_Method (store vs deflate):_

| entry kind | method | rule |
|---|---|---|
| regular blob (`100644`/`100755`) | `8` if deflate shrinks it, else `0` | git deflates **every** regular blob at the zlib **default level** (`Z_DEFAULT_COMPRESSION` → 6) and keeps method `8` only when `compressed < uncompressed`, else stores: `exec.sh` 18→20 ⇒ store, `regular.txt` 6→8 ⇒ store, `.gitmodules` 109→102 ⇒ deflate, `big.txt` 20000→37 ⇒ deflate |
| symlink (`120000`) | `0` | stored; **the entry data is the link-target bytes** (`csize = usize = len(target)`, e.g. `link` = `regular.txt` = 11 B), not a separate field |
| directory (`40000`), gitlink (`160000`) | `0` | size 0, csize 0, crc 0, **trailing-slash name** (`nested/`, `mysub/`); the gitlink is emitted as a plain dir entry, the submodule **not** recursed |

_Central-directory attributes (the mode encoding):_

| git mode | version-made-by | external attributes | internal attr |
|---|---|---|---|
| `100644` regular, text | `0x0000` (host-OS 0 = MS-DOS, spec 0) | `0x00000000` (mode not encoded) | `0x0001` |
| `100644` regular, binary (has NUL) | `0x0000` | `0x00000000` | `0x0000` |
| `100755` exec | `0x0317` (host-OS 3 = unix, spec 23 = 2.3) | `0x81ed0000` = `0o100755 << 16` | text `0x0001` / binary `0x0000` |
| `120000` symlink | `0x0317` (unix) | `0xa1ff0000` = `0o120777 << 16` | `0x0001` |
| `40000` directory | `0x0000` (MS-DOS) | `0x00000010` (DOS directory attribute, low half) | `0x0000` |
| `160000` gitlink | `0x0000` (MS-DOS) | `0x00000010` (same encoding as a directory) | `0x0000` |

- version-made-by is `0x0317` **iff** the entry carries a unix mode in its external
  attributes (exec **or** symlink); every other entry is `0x0000`.
- the encoded unix mode is the **raw git mode, no umask** — exec `0o100755`, symlink
  `0o120777` (git writes the symlink type bits `0o120000 | 0o777`) — in the high 16 bits
  of the external attributes; the low 16 bits carry the DOS attribute (`0x10` for dir/
  gitlink, else `0`).
- internal-attr bit 0 is git's **text flag**: set when the content is detected as text,
  cleared for binary — `binary.bin` (a NUL byte) → `0x0000`, every text blob → `0x0001`;
  directories/gitlinks → `0x0000`. The serializer reuses the in-tree NUL-sniff
  (`isBinary` / `hasNulInWindow`, `src/domain/diff/line-diff.ts:76`).

_Archive framing:_

| field | pinned value |
|---|---|
| end-of-central-directory | standard EOCD; **comment = the 40-hex peeled commit oid** (length 40) for a commit-ish; **empty** (length 0) for a bare tree — exactly mirroring the tar pax comment |
| `--prefix=pre/` | synthesises a top-level `pre/` directory entry (method 0, dir attrs) then prefixes every entry name (`pre/.gitmodules`, `pre/nested/`, …) — exactly like tar |

**DOS-time note (load-bearing non-determinism).** git derives the DOS mod-time/date from
`mtime` via `localtime`, so it is **machine-TZ-dependent** (pinned: UTC `0xa1a6/0x3287`,
`+0200` `0xb1a6/0x3287`, `+0530` next-day `0x0d66/0x3288`). The library must not read the
clock/TZ implicitly (ADR-249, determinism): the zip serializer takes the DOS-time
**`tzOffsetMinutes`** as a caller rendering input (default `0` = UTC) and computes the DOS
fields from `mtime` at that offset; the interop test runs `git archive --format=zip`
under `TZ=UTC` so both sides break the time down in UTC → byte-identical. The `UT`
extra-field timestamp is the raw epoch `commitTime` and is **TZ-independent**.

**Byte-identity contract (ADR-417) — empirically pinned, method-8 byte-equality is NOT
universal.** The raw-DEFLATE bitstream is zlib-implementation-coupled. Verified against
git 2.54.0: a highly-compressible blob (`20000×'A'` → git 37 bytes `edc1…f060`) coincides
with node:zlib at default/`-1`/`6`/`9`, **but** a varied 69-byte `.gitmodules` **diverges**
— git 64 bytes, node:zlib 67 (no level matches). git's own `git archive` zip is not stable
across zlib/git versions either, so perfect method-8 byte-faithfulness is **portably
impossible** and is **not** the contract. The faithful, achievable contract (the same
equivalence-under-readback precedent the loose-object compressors document) is:

- **method-0 (stored) entries and ALL framing** — local + central headers, CRC-32, the
  *uncompressed* size, the `UT` extra field, external/internal attributes, the EOCD +
  comment — are **byte-identical to git on every adapter**, because none of it passes
  through DEFLATE; the store-vs-deflate **method decision** matches git;
- **method-8 (compressed) entries are faithful by ROUND-TRIP, not byte-identity** (on
  **every** adapter, node included — node is not privileged): the payload is valid
  raw-DEFLATE that inflates to git's exact content; its compressed bytes (and that entry's
  `csize` + downstream offsets) equal git's only *incidentally*, never relied upon;
- the interop test compares **structurally** — same entry set/order/method, same
  CRC/usize/attrs/comment, method-0 payloads byte-equal, method-8 payloads round-trip to
  git's content — and keeps a whole-archive byte-equality assertion **only** for an
  all-stored fixture (no DEFLATE in play), where it is robust.

Note the mode divergence between formats: **tar applies `tar.umask` to a transformed base
mode; zip writes the raw git mode (umask-free) in its external attributes.** A single data
surface (raw mode) feeds both; each serializer owns its own mapping (tables M and Z).

**R — refusals (exit 128 each):**

| # | scenario | git stderr |
|---|---|---|
| R1 | outside a repo | `fatal: not a git repository (or any of the parent directories): .git` |
| R2 | unborn HEAD, `archive HEAD` | `fatal: not a valid object name: HEAD` |
| R3 | unresolvable rev | `fatal: not a valid object name: <rev>` |
| R4 | tree-ish is a **blob** | `fatal: not a tree object: <sha>` |
| R5 | unknown `--format` | `fatal: Unknown archive format '<fmt>'` (serializer selection is caller-side; N/A to the data surface) |

Default `git archive` format (no `--format`) is **tar** (pax global header observed).

### Architecture

Hexagonal, Tier-1 command composed from existing read primitives, plus a net-new
`domain/archive/` serializer module — `tar.ts` (pure, zero-dep) and `zip.ts` (pure over
an injected `deflateRaw`, reusing in-tree `crc32`) — and one **additive** `deflateRaw`
method on the `Compressor` port (ADR-417). The entry walk stays internal to the command
(no second consumer yet → YAGNI, mirroring fsck keeping its reachability closure inline;
promote to a public primitive only when a real consumer lands; ADR-418).

**Pipeline (`archive(ctx, opts)`):**

1. `assertRepository(ctx)` — refuse outside a repository (R1). (Same gate family as the
   other read commands; rev resolution surfaces the unborn-HEAD error R2 faithfully —
   no operational-config gate needed.)
2. **Resolve** `opts.treeish`: `oid = revParse(ctx, treeish)` (R2/R3 throw here);
   `obj = readObject(ctx, oid)`; classify (note `Commit` wraps its fields in `.data` —
   `{ type:'commit', id, data: CommitData }`, and `AuthorIdentity.timestamp` is the
   epoch seconds) —
   - `commit` → `{ tree: obj.data.tree, commit: oid, commitTime: obj.data.committer.timestamp }`
   - `tag` → `peel(ctx, oid, 'commit')` then as commit (then read it for tree + time)
   - `tree` → `{ tree: oid }` (no commit metadata)
   - `blob` → refuse R4 (`not a tree object`).
3. **Return** `ArchiveResult = { tree, commit?, commitTime?, entries }`, where `entries`
   is a lazy `AsyncIterable<ArchiveEntry>` = `walkTree(ctx, tree, { recursive: true,
   maxEntries: … })` mapped to hydrate blob bytes: for a blob/symlink entry, `content =
   (await readBlob(ctx, id)).content`; for a directory/gitlink entry, `content` omitted.
   **Entry-cap note:** `walkTree` defaults `maxEntries` to `MAX_FLAT_TREE_ENTRIES`
   (`1_000_000`) and `maxDepth` to `1024`; `git archive` imposes no such bound, so
   `archive` must pass a git-faithful (effectively unbounded) `maxEntries`/`maxDepth`
   rather than inherit the diff-oriented defaults (a >1M-entry tree must not throw).

**Data surface (the command):**

```ts
repo.archive(opts: ArchiveOptions): Promise<ArchiveResult>;

interface ArchiveOptions {
  readonly treeish: string;   // required tree-ish (rev grammar); git refuses with no arg
}

interface ArchiveResult {
  readonly tree: ObjectId;            // the resolved tree being exported
  readonly commit?: ObjectId;         // peeled commit oid (pax/zip comment), undefined for a bare tree
  readonly commitTime?: number;       // committer epoch seconds (default mtime), undefined for a bare tree
  readonly entries: AsyncIterable<ArchiveEntry>;
}

interface ArchiveEntry {
  readonly path: FilePath;            // path within the tree, NO prefix (prefix is rendering)
  readonly mode: FileMode;            // RAW git mode (100644/100755/120000/40000/160000)
  readonly oid: ObjectId;             // blob / tree / commit(gitlink) oid
  readonly content?: Uint8Array;      // blob bytes incl. symlink target; absent for directory & gitlink
}
```

`mode` discriminates serializer framing (`isDirectory` / `=== GITLINK` / `=== SYMLINK`
/ else regular). `content` present iff the entry is a blob or symlink. Branded
`FilePath`/`FileMode`/`ObjectId` reused from `src/domain/objects/`.

**Serializer (separate, pure, swappable — `domain/archive/tar.ts`, ADR-416/418):**

```ts
// pure, zero-dep; the consumer's swap-point. NOT returned by the command.
function tarArchive(
  result: ArchiveResult,
  opts?: { prefix?: string; mtime?: number; umask?: number; uname?: string; gname?: string },
): AsyncIterable<Uint8Array>;
```

Defaults reproduce git: `umask 0o0002`, `uname`/`gname` `'root'`, `mtime =
result.commitTime` (caller **must** supply for a bare tree to get a deterministic
archive). It emits the pax global header iff `result.commit` is defined, then per
entry a ustar header (mode-mapped per table **M**, prefixed name, typeflag per mode,
symlink target in `linkname`) + 512-padded content, then the EOF zero-blocks padded to
10240 (rule **D**). `prefix` prepends to every path and synthesises a top-level
`<prefix>` directory entry (pinned: `git archive --prefix=pre/` emits `pre/` then
`pre/a.txt` …).

**Serializer (separate, swappable, pure-over-injection — `domain/archive/zip.ts`,
ADR-417/418):**

```ts
// pure over an injected raw-DEFLATE callback; the consumer's swap-point. NOT returned by the command.
function zipArchive(
  result: ArchiveResult,
  deps: { deflateRaw: (data: Uint8Array, level?: number) => Promise<Uint8Array> },
  opts?: { prefix?: string; mtime?: number; tzOffsetMinutes?: number; level?: number },
): AsyncIterable<Uint8Array>;
```

zip has **no** `umask`/`uname`/`gname` (it writes the raw git mode, table **Z**), but it
does need `tzOffsetMinutes` (default `0` = UTC) for the DOS time fields. `deflateRaw` is
**injected** (ADR-418): the library wires `ctx.compressor.deflateRaw` (the interop test
and any in-library zip emission pass the node adapter's), while an external consumer
injects any RFC-1951 deflate — the framer stays platform-free and unit-testable against a
stub deflate. For each regular blob the framer calls `deflateRaw(content, level)`, keeps
method 8 iff the result is smaller (else method 0 store, table **Z**), reuses `crc32` for
the CRC fields, sets internal-attr bit 0 from the in-tree NUL-sniff, and emits the local
file header + `UT` extra, then the central directory, then the EOCD whose comment is
`result.commit` (absent for a bare tree). `prefix` synthesises a `<prefix>` dir entry
exactly as tar does. Because the central directory trails all entries, the framer
accumulates a small per-entry record (name, offset, crc, sizes, method, mode) as it
streams — **metadata only, never the blob bytes** — so lazy blob streaming (ADRs 383–394)
still holds.

**Reuse:** `revParse`, `readObject`, `readBlob`, `peel`, `walkTree`,
`assertRepository`, `crc32` (zip CRC fields), `isBinary`/`hasNulInWindow` (zip text bit),
`serializeTreeContent`-style byte assembly.
**Net-new:** `domain/archive/tar.ts` (pure tar framer + its `ArchiveEntry` types),
`domain/archive/zip.ts` (zip framer, pure over injected `deflateRaw`), the additive
`Compressor.deflateRaw` port method + node/browser/memory implementations,
`application/commands/archive.ts` (+ `internal/archive/` if the entry-walk map needs a
home). The entry walk is **not** a public primitive in v1 (YAGNI).

### Refusal & error semantics

- **Non-repository → throw** the project `notARepository` (R1). **Unresolvable /
  unborn rev → throw** the existing rev-vocabulary error (R2/R3). **Blob tree-ish →
  throw** `not a tree object` (R4) — reuse `peel`/`unexpectedObjectType`-class errors;
  assert the `.data.code`, not just the class (mutation-resistant).
- A **successful** resolve yields an `ArchiveResult` whose entry stream does not throw
  for a healthy tree. (A corrupt object mid-walk surfaces `walkTree`'s existing
  faults — git archive likewise aborts on a bad object; matching that is faithful.)

## Decision candidates

All five were ratified in the decisions/ADR phase. The table records the **chosen
option and its ADR**, not a fresh recommendation. DC2 **deviated** from the design's
original "defer zip" recommendation.

| # | Choice | Alternatives (≤3) | Decision (ADR) | Why |
|---|---|---|---|---|
| 1 | Surface shape of the result | (a) bare `AsyncIterable<ArchiveEntry>`; (b) aggregated `Promise<{ commit?, commitTime?, entries: ArchiveEntry[] }>`; (c) `Promise<ArchiveResult>` = metadata + a lazy `entries: AsyncIterable` | **(c) — ADR-415, user-ratified** | Brief says "stream"; blobs can be huge so eager arrays (b) violate the blob-streaming direction (ADRs 383–394) & perf priorities; but the commit oid/time + refusals must surface up-front, which a bare iterable (a) can't carry. (c) = await for metadata+refusal, iterate entries lazily. |
| 2 | Serializer scope in THIS PR | (a) entry-stream only, no serializer (interop reconstructs git bytes from entries); (b) entry-stream **+ tar** serializer, defer zip; (c) entry-stream + tar + zip | **(c) — ADR-417, user-ratified (DEVIATION from the design's (b) recommendation)** | The design recommended (b) on the belief that zip needs a new port capability (the `Compressor` port only does zlib RFC-1950). Investigation retired that: raw DEFLATE is **already native** in every adapter — node `node:zlib` `deflateRawSync`, browser/memory `CompressionStream('deflate-raw')` — and `crc32` is in-tree, so zip needs **zero new dependencies and no shim**, only one additive `deflateRaw` port method. zip lands here; node:zlib reproduces git's method-8 bytes exactly (matrix **Z**). (a) ships a Tier-1 `archive` that can't produce an archive. No deferred-zip follow-up is filed. |
| 3 | Where commit metadata + rendering inputs live (ADR-249) | (a) command returns `commit`/`commitTime` as **data** + raw modes; serializer takes caller `prefix`/`mtime`/`umask`/`level` (git defaults); (b) bake `prefix`/`mtime`/`umask` into the command options / entries; (c) command computes nothing, caller supplies all | **(a) — ADR-416, adopted** | Only (a) honours ADR-249 (the `describe` precedent): the lib ships oids/timestamps/entries (data); the consumer owns prefix/mtime/umask/level (rendering), the serializer defaulting them to git's values so byte-parity is reproducible. Raw modes in the stream let tar (umask) and zip (raw) each apply their own pinned mapping (table M/Z). (b) puts cosmetics on the data surface; (c) drops faithful commit metadata the lib *can* compute. |
| 4 | Module placement | (a) serializers in **pure `domain/archive/`** (public, swappable) + entry-walk **internal** to the command; (b) everything inline in `commands/archive.ts` + `internal/archive/`, nothing public beyond the command; (c) a new top-level `serializers/` tree | **(a) — ADR-418, adopted** | Byte-framing is pure domain logic like `serializeTreeContent`/`serializeObject` → belongs in `domain/`, public is exactly the "swap your own container" separability the brief wants. `tar.ts` is zero-dep; `zip.ts` stays pure by **injecting** `deflateRaw` (the port capability lives in the adapter, ADR-417). The entry walk has no second consumer yet → keep internal (YAGNI, fsck kept its closure inline). (c) fights the repo's by-layer organisation. |
| 5 | Repository-state gate | (a) `assertRepository` (repo exists); (b) `assertOperationalRepository` (adds `[core]`/HEAD validity) | **(a) — ADR-419, adopted** | `archive` is a plain read; git's only non-rev refusal is "not a git repository" (R1), and the unborn-HEAD case (R2) is a *rev*-resolution error, not a repo-state gate — `assertRepository` + `revParse` reproduces both faithfully without over-gating. |

## Test strategy

- **Unit** (`test/unit/application/commands/archive.test.ts`, memory adapter):
  GWT/AAA, `sut = archive`, 100% line/branch/function + 0 surviving mutants. Isolated
  cases: commit tree-ish → `commit`/`commitTime` populated + entry stream order;
  bare-tree tree-ish → `commit`/`commitTime` `undefined`; annotated tag → `commit` =
  the **peeled** commit oid (not the tag oid); each entry kind (regular/exec carry
  `content`; symlink carries target bytes; directory + gitlink omit `content` and carry
  raw mode `40000`/`160000`); pre-order with the directory entry before its contents;
  empty tree → empty entry stream + no commit metadata; each refusal R1–R4 asserted on
  its `.data.code` (never `toThrow(Class)` alone), with the blob-refusal guard isolated.
- **tar serializer unit** (`test/unit/domain/archive/tar.test.ts`): per-kind header
  bytes — mode mapping table **M** (regular `0664`, exec `0775`, dir/gitlink `0775`,
  symlink `0777`), typeflags, the unsigned-sum checksum, `uname`/`gname` `root`, the
  pax global header present-iff-commit with the `52 comment=<oid>\n` record, the
  `--prefix` synthesised top dir entry, and the 10240-block EOF padding. Each mode-map
  arm isolated (mutation-resistant — the `& ~umask` and the symlink-unmasked branch
  each get their own case).
- **zip serializer unit** (`test/unit/domain/archive/zip.test.ts`, with a stub
  `deflateRaw`): per-entry local + central header bytes against matrix **Z** — version
  needed `10`, flags `0x0000`, the `UT` extra (`555405000159945542`-shape, mtime LE), the
  CRC-32 field; method selection (method 8 iff the stub returns fewer bytes, else store —
  each arm isolated); version-made-by + external-attr per kind (regular `0x0000`/`0`, exec
  `0x0317`/`0o100755<<16`, symlink `0x0317`/`0o120777<<16`, dir/gitlink `0x0000`/`0x10`);
  internal-attr text bit set for text / cleared for a NUL blob; the trailing-slash dir +
  gitlink entries; the `--prefix` synthesised dir entry; the EOCD comment = commit oid
  (present-iff-commit); the `tzOffsetMinutes` DOS time/date encoding. Each ext-attr and
  method arm gets its own case (mutation-resistant).
- **`deflateRaw` port unit** (the three `*-compressor.test.ts` files, one per adapter):
  `deflateRaw(data)` output round-trips through a test-side raw-inflate (`node:zlib`
  `inflateRawSync` / `DecompressionStream('deflate-raw')`) back to `data`; node's output is
  byte-exact against `node:zlib` `deflateRawSync` at the default level; the `level` param is
  honoured (node) / accepted-and-ignored (browser/memory, per the existing `deflate`
  precedent). Output carries **no** zlib header/adler trailer (RFC 1951, not 1950) — which
  distinguishes it from `deflate`. (The port gains only `deflateRaw`; raw-inflate stays
  test-side, ADR-417.)
- **Properties** (lens 1, round-trip — `tar.properties.test.ts`): over an arbitrary
  small `ArchiveEntry` stream, `parseTar(tarArchive(entries)) ≡ entries` (modulo the
  documented mode normalisation + the synthesised pax/EOF framing) — a serialize/parse
  round-trip proves the framing grammar, not just the pinned examples. (`numRuns` 200.)
  A minimal in-test tar reader is the independent oracle (not a copy of the writer).
- **zip framing properties** (lens 1, round-trip — `zip.properties.test.ts`): over an
  arbitrary small `ArchiveEntry` stream, `parseZip(zipArchive(entries, { deflateRaw }))
  ≡ entries` (modulo the synthesised dir/EOCD framing and the store/deflate choice) — a
  minimal in-test zip reader (independent of the writer) raw-inflates method-8 entries
  (test-side, not a port method) and reads method-0 entries verbatim. (`numRuns` 200.)
- **tar interop** (`test/integration/archive-interop.test.ts`, real-git twin via
  `interop-helpers.ts`'s scrubbed `runGit`): one tmp repo per matrix row; build trees
  with a regular file, exec file, symlink, nested dir, a gitlink, a compressible blob,
  and a binary (NUL) blob; run `repo.archive()`, **reconstruct git's tar bytes from
  `ArchiveResult` via `tarArchive`** and assert byte-equality with
  `git archive --format=tar <treeish>` (default flags, then `--prefix=pre/`, then a
  bare-tree arg with a fixed `mtime`, then an annotated tag). Cover the
  pax-global-header-present-iff-commit, the umask mode mapping, the gitlink-as-empty-dir,
  the symlink linkname, and the 10240 padding.
- **zip interop** (same file, **node adapter**, run under `TZ=UTC` so DOS times line up):
  reconstruct git's zip bytes from `ArchiveResult` via `zipArchive(result, { deflateRaw:
  node.compressor.deflateRaw }, { tzOffsetMinutes: 0 })` and assert **byte-equality** with
  `git archive --format=zip <treeish>` over the same matrix — **including method-8**
  entries (the `.gitmodules`/`big.txt` blobs), the store/deflate boundary
  (`exec.sh`/`regular.txt` store), version-made-by + external-attr per kind, the internal
  text bit (text vs the NUL blob), the `UT` extra, the trailing-slash dir + gitlink
  entries, `--prefix`, and the EOCD comment = commit oid (empty for a bare tree).
- **Parity scenario** (`test/parity/scenarios/archive.scenario.ts` + `index.ts`
  registration): a small repo (one regular file + one nested dir + one compressible blob)
  asserting the same structured `entries` projection (paths, modes, `content` lengths) +
  `commit`/`tree` oids on node / memory / browser. It also frames **zip** on each adapter
  and asserts cross-adapter equivalence **structurally / by round-trip** — method-0
  entries and all framing are byte-identical across adapters, while method-8 bytes are
  compared by `inflateRaw`-readback to the original blob (the byte-identity contract in
  **Z**: cross-adapter DEFLATE bytes are not pinned). (Parity proves cross-adapter
  consistency, **not** faithfulness — the interop slice owns byte-faithfulness.)

## Out of scope

- **tgz / other formats** — v1 ships **tar and zip** (DC2 / ADR-417); `tar.gz` is tar
  piped through gzip (the `deflate` port already exists), a thin follow-up. No further
  container format is in v1.
- **`--worktree-attributes` / `export-ignore` / `export-subst` `.gitattributes`
  filtering** — git archive honours `export-ignore`/`export-subst` attributes; v1
  archives the raw tree. (Faithful divergence candidate for a later ADR; flagged, not
  silently dropped.)
- **Pax `x` extended header for >255-byte paths** — v1's tar framer handles ≤255 bytes
  via the ustar `name`+`prefix` split (git's behaviour for that range); the rare
  >255-byte path (pax `x` `path=` record) is a serializer follow-up.
- **Reading the wall clock / TZ implicitly** — git stamps "now" for a bare-tree `mtime`
  (non-deterministic), and derives the zip **DOS date/time from `mtime` in machine-local
  TZ** (matrix **Z**). The library reads neither: a bare-tree archive requires a
  caller-supplied `mtime`, and the zip serializer takes `tzOffsetMinutes` (default `0` =
  UTC) rather than reading the process TZ — rendering/environment is the caller's
  (ADR-249), and the interop test pins git to `TZ=UTC` for byte-parity.
- **Streaming the tar/zip to a sink / file** — the serializers yield
  `AsyncIterable<Uint8Array>`; persisting it is the caller's (no write surface in
  `archive`).
- **Submodule/gitlink content** — emitted as an empty directory entry, never recursed
  (matches git, which has no access to the submodule's objects from the superproject).
- **Trailing pathspec path-limiting** (`git archive HEAD <path>…` to restrict the
  archive to a subtree/paths) — v1 archives the whole resolved tree; `treeish` is the
  only input. A pathspec-limited surface is a follow-up.
