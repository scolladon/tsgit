# `fsck`

Verify object integrity and connectivity in the repository — the structured
equivalent of `git fsck`. Returns **structured data only**: each problem is a
typed `FsckFinding` variant carrying the object IDs, severity, and msg-id
needed to reconstruct git's `error in <type> <sha>: …` / `warning in …` output
(the library ships findings as data; reconstructing git's stdout/stderr lines,
stream routing, and exit-code rendering is the caller's job).

## Signature

```ts
repo.fsck(opts?: FsckOptions): Promise<FsckResult>;

type FsckObjectType = 'commit' | 'blob' | 'tree' | 'tag';
type FsckSeverity   = 'error' | 'warning' | 'info';

type FsckFinding =
  | { readonly type: 'dangling';
      readonly id: ObjectId; readonly objectType: FsckObjectType | 'unknown' }
  | { readonly type: 'unreachable';
      readonly id: ObjectId; readonly objectType: FsckObjectType | 'unknown' }
  | { readonly type: 'missing';
      readonly id: ObjectId; readonly objectType: FsckObjectType | 'unknown' }
  | { readonly type: 'broken-link';
      readonly fromId: ObjectId; readonly fromType: FsckObjectType;
      readonly toId: ObjectId;   readonly toType: FsckObjectType | 'unknown' }
  | { readonly type: 'bad-object';
      readonly id: ObjectId; readonly objectType: FsckObjectType | 'unknown';
      readonly msgId: string; readonly severity: FsckSeverity }
  | { readonly type: 'hash-mismatch';
      readonly id: ObjectId; readonly actual: ObjectId }
  | { readonly type: 'bad-ref';
      readonly ref: RefName; readonly msgId: string;
      readonly severity: FsckSeverity; readonly target?: ObjectId;
      readonly path?: string; readonly reason?: 'PERMISSION_DENIED';
      readonly referent?: string; readonly trailing?: string }
  | { readonly type: 'unreadable-ref-path';
      readonly path: string; readonly operation: 'open-directory' | 'stat';
      readonly reason: 'PERMISSION_DENIED' }
  | { readonly type: 'refs-walk-failed'; readonly path: string;
      readonly reason: 'PERMISSION_DENIED' }
  | { readonly type: 'refs-verify-ended'; readonly ref: RefName; readonly path: string;
      readonly reason: 'FILE_NOT_FOUND' | 'NOT_A_DIRECTORY' | 'PERMISSION_DENIED' | 'SYMLINK_LOOP' }
  | { readonly type: 'root'; readonly id: ObjectId }
  | { readonly type: 'tagged';
      readonly id: ObjectId; readonly objectType: FsckObjectType;
      readonly tagName: string; readonly tag: ObjectId }
  | { readonly type: 'pack-inaccessible';
      readonly pack: string; readonly reason: string }
  | { readonly type: 'pack-index-unusable';
      readonly pack: string; readonly reason: string }
  | { readonly type: 'pack-rev-index-unusable';
      readonly pack: string; readonly reason: string }
  | { readonly type: 'pack-rev-index-invalid';
      readonly pack: string; readonly reason: string }
  | { readonly type: 'pack-rev-index-position-mismatch';
      readonly pack: string; readonly position: number;
      readonly expected: number; readonly stored: number }
  | { readonly type: 'midx-unusable';
      readonly artefact: string; readonly reason: string }
  | { readonly type: 'midx-checksum-mismatch';
      readonly artefact: string }
  | { readonly type: 'midx-pack-unresolved';
      readonly artefact: string; readonly position: number; readonly pack: string }
  | { readonly type: 'midx-entry-unresolved';
      readonly artefact: string; readonly id: ObjectId }
  | { readonly type: 'bitmap-checksum-mismatch';
      readonly artefact: string }
  | { readonly type: 'commit-graph-invalid';
      readonly artefact: string } & CommitGraphVerdict   // verdict is `{ check: …, … }`
  | { readonly type: 'invalid-reflog-entry';
      readonly ref: RefName; readonly id: ObjectId }
  | { readonly type: 'invalid-cache-tree-pointer';
      readonly id: ObjectId; readonly index: string }
  | { readonly type: 'invalid-resolve-undo-pointer';
      readonly id: ObjectId; readonly index: string }
  | { readonly type: 'no-default-references' }
  | { readonly type: 'unknown-object-type'; readonly id: ObjectId }
  | { readonly type: 'unexpected-object-type';
      readonly id: ObjectId; readonly expectedType: 'commit' | 'tree' | 'tag' }
  | { readonly type: 'type-conflict';
      readonly id: ObjectId; readonly objectType: FsckObjectType;
      readonly expectedType: FsckObjectType }
  | { readonly type: 'unparseable-object';
      readonly id: ObjectId; readonly pack?: string }
  | { readonly type: 'bad-pointer';
      readonly id: ObjectId; readonly link: 'tree' | 'parent' | 'tag';
      readonly target: ObjectId }
  | { readonly type: 'broken-links';
      readonly id: ObjectId; readonly objectType: FsckObjectType }
  | { readonly type: 'unresolved-link';
      readonly fromId: ObjectId; readonly fromType: FsckObjectType;
      readonly toType: FsckObjectType }
  | { readonly type: 'pack-index-checksum-mismatch'; readonly pack: string }
  | { readonly type: 'pack-checksum-mismatch'; readonly pack: string }
  | { readonly type: 'pack-crc-mismatch';
      readonly pack: string; readonly id: ObjectId; readonly offset: number }
  | { readonly type: 'pack-entry-unpackable';
      readonly pack: string; readonly id: ObjectId; readonly offset: number }
  | { readonly type: 'pack-entry-corrupt';
      readonly pack: string; readonly id: ObjectId };
// Findings from an alternate's object store also carry `objectsDir?: string`
// (`bad-object`, `hash-mismatch`, `unparseable-object` and every pack-*, midx-*,
// bitmap-* and commit-graph-* variant); it is absent for the primary store.

interface FsckOptions {
  readonly connectivityOnly?: boolean;
  readonly reflogRoots?:      boolean;
  readonly indexRoot?:        boolean;
  readonly full?:             boolean;
  readonly strict?:           boolean;
  readonly checkReferences?:  boolean;
}

interface FsckResult {
  readonly findings: ReadonlyArray<FsckFinding>;
  readonly exitCode: number;
}
```

## Options

| Field | Type | Default | Meaning |
|---|---|---|---|
| `connectivityOnly` | `boolean` | `false` | Skip object-content validation (git's `--connectivity-only`); only verify that linked objects exist. |
| `reflogRoots` | `boolean` | `true` | Treat reflog OIDs as reachability roots (git's default). Set `false` to exclude reflogs. |
| `indexRoot` | `boolean` | `true` | Treat index blob OIDs — and, when present, the index's cache-tree tree OIDs — as reachability roots (git's default). Set `false` to exclude the index from every role: roots and the cache-tree check below. |
| `full` | `boolean` | `true` | Include pack objects (git's `--full`). Set `false` to scan loose objects only. |
| `strict` | `boolean` | `false` | Upgrade WARN-class msg-ids to ERROR and contribute exit bit 1 (git's `--strict`). |
| `checkReferences` | `boolean` | `true` | Run the `git refs verify` ref-content pass; malformed ref content produces `bad-ref` findings with exit bit 8. |

### Caller projections (the library ships data, not rendering)

git's `--dangling`, `--unreachable`, `--root`, and `--tags` flags are **not**
options — the maximal finding taxonomy is always computed. Filter the returned
`findings` array on the caller side:

```ts
// git's "dangling <type> <sha>" (stdout)
findings.filter(f => f.type === 'dangling')

// git's "unreachable <type> <sha>" (--unreachable, stdout)
findings.filter(f => f.type === 'unreachable')

// git's "--root" report (stdout)
findings.filter(f => f.type === 'root')

// git's "--tags" report (stdout)
findings.filter(f => f.type === 'tagged')
```

## Finding variants

| `type` | Fields (beyond `type`) | When emitted |
|---|---|---|
| `dangling` | `id`, `objectType` (`FsckObjectType \| 'unknown'`) | Object present but reachable from no root and has no in-edge from another present object (tip of an unreachable subgraph). `objectType` is `'unknown'` only under `connectivityOnly: true`, and only when no stored header could be obtained for the object at all — an unopenable or empty loose file, or an id only an unusable pack supplies. Exit 0. |
| `unreachable` | `id`, `objectType` (`FsckObjectType \| 'unknown'`) | Object present but not reachable from any root (superset of `dangling`). Same `'unknown'` rule as `dangling`. Exit 0. |
| `missing` | `id`, `objectType` (`FsckObjectType \| 'unknown'`) | Referenced object absent from store — or present but content-unreadable/hash-mismatched with no pack copy backing it, typed from the referencing edge in either case (see "never typed" below). Exit bit 2. |
| `broken-link` | `fromId`, `fromType`, `toId`, `toType` (`FsckObjectType \| 'unknown'`) | Edge from a present object to an absent one. Exit bit 2. |
| `bad-object` | `id`, `objectType` (`FsckObjectType \| 'unknown'`), `msgId`, `severity` | Object-content validation failure from the named msg-id catalogue, or corrupt/undecodable object. Exit bit 1 (ERROR-class or `--strict`-upgraded). `objectType` is `'unknown'` when the object is undecodable and its type cannot be determined. A loose object — blob, commit, tree or tag alike — whose body overruns its header's size claim past git's 32-byte header window is undecodable for this same reason (`msgId: 'unterminatedHeader'`) — git's buffered loose tier refuses it exactly as it refuses an unparseable header, reported the way `git fsck --full` reports `object corrupt or missing`. A **blob** past `core.bigFileThreshold` (default 512 MiB, strict `>`) takes git's streamed route (`check_stream_oid`) instead: an over-run there is undecodable the same way; a claim at or above the 2 GiB inflate ceiling is also `unterminatedHeader` — reachable under default config for a commit, tree or tag, and for a blob only when `core.bigFileThreshold` is configured above 2 GiB. |
| `hash-mismatch` | `id`, `actual` | File content hashes to `actual`; file's path implies `id`. A loose object — blob, commit, tree or tag alike — whose body disagrees with its header's size claim, but still resolves, hashes the same bytes git's own buffered loose tier would serve — the claimed prefix when the body overran the claim but still fit the header window, or the real body zero-padded out to the claim when it under-ran — never the claim length or the real on-disk length on their own; `actual` is that hash, matching `git fsck --full`'s own "hash-path mismatch" line. A **blob** past `core.bigFileThreshold` under-runs unpadded instead: git's streamed route hashes the declared header plus the real bytes with no padding, never a claim-sized zero fill — `core.bigFileThreshold` gates blobs only, a commit/tree/tag under-run is always zero-padded regardless of size. tsgit's zero-padding is its own deterministic choice for bytes git's `xmallocz` leaves uninitialised — git's own reported hash for the same under-run claim is not reproducible run to run, so only the `hash-path mismatch, found at: <path>` line and the exit code are git-pinned, never a specific zero-padded value. Exit bit 1. |
| `bad-ref` | `ref`, `msgId`, `severity`, `target?`, `path?`, `reason?`, `referent?`, `trailing?` | Refs-verify pass finding: malformed ref content (`badRefContent` — exit bit 8) or ref pointing at an absent/zero OID (`badRefOid` / *invalid sha1 pointer* — exit bit 2). `target` is present when the ref had a syntactically-valid OID target. A loose ref file the permissions refuse to open (under `refs/` or beside it, or a linked worktree's `HEAD`) reports `msgId: 'cannotReadRef'` with `path` (absolute, as opened) and `reason: 'PERMISSION_DENIED'`; it is always an `error`, no `fsck.<msg-id>` setting or `--strict` re-types it, it sets exit bit 8, and `checkReferences: false` drops it. The run carries on, and the ref gets its zero `badRefOid` pointer. A loose symbolic ref whose referent git rejects (not a root ref, not a well-formed name of two or more components) reports `msgId: 'badReferentName'` (default `error`, exit bit 8) with `referent`, the name as read; a referent that is neither a root ref nor under `refs/` or `worktrees/` also reports `symrefTargetIsNotARef` (default `info`, no exit bit unless configured `error`), dropped when the same ref's `badReferentName` is an `error`. Both honour `fsck.<msg-id>`; `--strict` never upgrades them. A loose body with bytes after the object name reports `trailingRefContent` with `trailing`, those bytes; a symbolic body with trailing whitespace reports it without `trailing`; a body missing its final line feed reports `refMissingNewline`. Both default to `info` (no exit bit unless configured `error`), honour `fsck.<msg-id>`, and survive a `badReferentName` on the same ref. |
| `root` | `id` | Root commit (no parents). Emitted when the caller filters for `type === 'root'`. Exit 0. |
| `tagged` | `id`, `objectType`, `tagName`, `tag` | Tag target: `id` is the tagged object, `tag` is the tag object OID. Emitted when the caller filters for `type === 'tagged'`. Exit 0. |
| `pack-inaccessible` | `pack`, `reason` | A pack failed the header gate — bad version, bad signature, truncated file, a header/index object-count disagreement, or a `.pack` that could not be opened. Full mode only (suppressed by `full: false` or `connectivityOnly: true`). Exit bit 1. |
| `pack-index-unusable` | `pack`, `reason` | A pack's `.idx` could not be read or parsed. Full mode only; always accompanied by a `pack-rev-index-unusable` finding for the same pack. Exit bit 1. |
| `pack-rev-index-unusable` | `pack`, `reason` | A pack's index is unusable, so no reverse index can be derived from it either. Full mode only, like the other pack findings: `connectivityOnly` and `full: false` skip it, as git 2.56 does. Exit bit 1. |
| `pack-rev-index-invalid` | `pack`, `reason` | A pack's `.rev` file exists and is readable, but is itself wrong — a malformed header (bad signature/version/hash-id), a size that disagrees with the pack's own object count, or a trailer checksum (verified with the repository's own hash algorithm, never the file's declared `hashId`) that disagrees with its content. Never emitted for a pack `pack-rev-index-unusable` already covers — an unusable `.idx` masks its `.rev` entirely. Full mode only (suppressed by `full: false` or `connectivityOnly: true`). Exit bit 1. |
| `pack-rev-index-position-mismatch` | `pack`, `position`, `expected`, `stored` | A `.rev` file parses and its checksum is valid, but body entry `position` disagrees with the index position the pack's own `.idx` implies (`expected`) — `stored` is the value the file actually has there. One finding per wrong position. Full mode only (suppressed by `full: false` or `connectivityOnly: true`). Exit bit 1. |
| `midx-unusable` | `artefact`, `reason` | The multi-pack-index (or a chain layer) actually in use was discarded — too small, unreadable, a chunk offset outside the file, a hash-version mismatch, with no usable fallback layer — or the entry-resolution walk hit a structural fault reached only inside this pass. `artefact` names the file; `reason` is tsgit's own wording, not reconstructed from git's stderr. A dropped chain that still leaves a usable layer, or a discarded flat file rescued by a loadable chain, produces no finding. Not reported under `connectivityOnly`. Exit bit 1. |
| `midx-checksum-mismatch` | `artefact` | The in-use artefact's trailer digest disagrees with its declared content — checked once per `fsck` run, on the flat file or the chain head only (never a base layer), and never on the ordinary read path. Not reported under `connectivityOnly`. Exit bit 1. |
| `midx-pack-unresolved` | `artefact`, `position`, `pack` | A `PNAM` entry — `position` is its chain-global index — names a pack that could not be resolved this scan, and whose `.pack` file is also gone. Not reported under `connectivityOnly`. Exit bit 1. |
| `midx-entry-unresolved` | `artefact`, `id` | An object the midx routes to a pack that cannot serve it — fires even when the pack itself resolved (its `.pack` is on disk but its `.idx` is not), independently of `midx-pack-unresolved`. Not reported under `connectivityOnly`. Exit bit 1. |
| `bitmap-checksum-mismatch` | `artefact` | A pack's `.bitmap`, or the in-use multi-pack-index's bitmap, is present and readable but its trailing digest disagrees with the bytes that precede it — the checksum is this artefact's entire obligation, so this is the only bitmap fault tsgit reports. `artefact` is `<base>.bitmap` for a pack, or `multi-pack-index-<hex>.bitmap` (composed from the in-use midx's own stored trailer bytes) for the midx. Absent, unreadable, or a structurally corrupt bitmap whose checksum still matches all produce no finding. Not reported under `connectivityOnly`; the midx arm is not gated by `core.multiPackIndex`. Exit bit 1. |
| `invalid-reflog-entry` | `ref`, `id` | A reflog side names an object the run never recorded (git's `invalid reflog entry`); one finding per side, so a line can yield two. |
| `invalid-cache-tree-pointer` | `id`, `index` | A cache-tree entry names an object no store holds (git's `invalid sha1 pointer in cache-tree`); `index` is the index file naming it, one finding per worktree index. Exit bit 8. |
| `invalid-resolve-undo-pointer` | `id`, `index` | A regular-file resolve-undo stage names an object no store holds (git's `invalid sha1 pointer in resolve-undo`). Exit bit 8. |
| `unreadable-ref-path` | `path`, `operation`, `reason` | A path git's refs walk could not open or stat: a directory under `refs/` the permissions refuse to list (`operation: 'open-directory'`, git's `error opening directory`) or an entry it lists but cannot `lstat` (`operation: 'stat'`, git's `failed to stat`). `path` is absolute, as opened; `reason` is `'PERMISSION_DENIED'`. A warning: no exit bit, no `fsck.<msg-id>` setting or `--strict` re-types it, and `checkReferences: false` drops it. The walk carries on with the siblings; the refs below a directory it cannot list are skipped everywhere else, as in git. |
| `refs-walk-failed` | `path`, `reason` | git's `failed to iterate over` a `refs` root it could not open (the common one, or a linked worktree's own), reported right after the `unreadable-ref-path` warning that names the same directory. `path` is absolute, as opened; `reason` is `'PERMISSION_DENIED'`. Exit bit 8, gated by `checkReferences`. A directory below the root only warns. |
| `refs-verify-ended` | `ref`, `path`, `reason` | git's `refs verify` child died on a symlinked ref whose real path cannot be resolved (git's `fatal: Invalid path` / `More than N nested symlinks`). `ref` is the link, `path` the absolute path where the resolution stopped, `reason` the fault: `'FILE_NOT_FOUND'`, `'NOT_A_DIRECTORY'`, `'PERMISSION_DENIED'` or `'SYMLINK_LOOP'`. Every content finding that would come after it is lost, as in git; the `badRefOid` pointers stand. Exit bit 8, gated by `checkReferences`. |
| `no-default-references` | _none_ | No ref names an object git could parse (git's `No default references` notice); no `unreachable` object is reported after it. No exit bit. |
| `unknown-object-type` | `id` | `connectivityOnly`: a reflog-reached object whose served copy hashes to another id and that no earlier link typed (git's `Unknown object type for`): reached, never walked. No exit bit. |
| `unexpected-object-type` | `id`, `expectedType` | `connectivityOnly`: an object a link typed as `expectedType` whose served copy is another type (git's `Object <id> not a <type>`): reached, never walked. No exit bit. |
| `type-conflict` | `id`, `objectType`, `expectedType` | A lookup asked for `expectedType` of an object an earlier lookup typed `objectType` (git's `object <id> is a <objectType>, not a <expectedType>`); the asking parse or walk gets no object. No exit bit. |
| `unparseable-object` | `id`, `pack?` | An object whose own parse failed on a type conflict (git's `object corrupt or missing`, for a loose copy and a pack entry alike): never checked, never recorded as present. Exit bit 1. |
| `bad-pointer` | `id`, `link`, `target` | A commit (`link: 'tree'` or `'parent'`) or tag (`'tag'`) whose link names `target` under a type conflict (git's `bad tree pointer`, `bad parent`, `bad tag pointer to`). No exit bit of its own. |
| `broken-links` | `id`, `objectType` | An object whose check could not look up one of its links (git's `error in <type> <id>: broken links`). Exit bit 1. |
| `unresolved-link` | `fromId`, `fromType`, `toType` | A link the reachability walk could not look up as `toType` (git's `broken link from <type> <id>`). Exit bit 2. |
| `pack-index-checksum-mismatch` | `pack` | A pack's `.idx` trailing checksum disagrees with its bytes. Full mode. Exit bit 1. |
| `pack-checksum-mismatch` | `pack` | A pack's trailing checksum disagrees with the bytes before it. Full mode. Exit bit 1. |
| `pack-crc-mismatch` | `pack`, `id`, `offset` | A pack entry's raw bytes disagree with the CRC-32 its `.idx` records; `offset` is the entry's byte offset. Full mode. Exit bit 1. |
| `pack-entry-unpackable` | `pack`, `id`, `offset` | A packed entry that cannot be unpacked (git's `cannot unpack`). Full mode. A `REF_DELTA` cycle and a zero-distance `OFS_DELTA` base are reported this way. |
| `pack-entry-corrupt` | `pack`, `id` | A packed entry whose content does not hash to its indexed id. Full mode. |
| `commit-graph-invalid` | `artefact`, plus the verdict's `check` and its fields | `git commit-graph verify` over each object source's commit-graph file (or its chain) reported a disagreement while `core.commitGraph` is on. `check` names it: `checksum`, `load-failure`, `oid-order`, `fanout`, `graph-unparsable`, `extra-edges-out-of-bounds`, `invalid-parent-position`, `odb-unparsable`, `root-tree`, `parent`, `parents-too-long`, `parents-terminate-early`, `generation`, `commit-date`, `mixed-generations`, `chain-unopenable`, `layer-load-failure`, `chain-line-not-hash`, `chain-too-small`, `chain-no-base-chunk`, `chain-base-chunk-too-small`, `chain-mismatch`, `chain-layer-missing`, `chain-incomplete` or `chain-unloaded`. Exit bit 16. |

`pack` is the pack's base name (`pack-<sha>`), already vetted at scan time against path
separators, `..`, and control characters — but it is **not shell-safe** (spaces, quotes, `$`,
backticks survive that filter); quote it before interpolating into a shell command or composing
a path from it. `reason` is a short description of the fault; the wording is tsgit's own, not
reconstructed from git's stderr text.

## Behaviour

- **`fsck.<msg-id>` re-types a finding.** Each configured msg-id (key halves are case-insensitive, values are the case-sensitive `error` / `warn` / `ignore`) replaces that message's severity: `error` reports it and contributes its exit bit, `warn` reports it with none, `ignore` drops the finding entirely. The configured value beats the catalogue default AND the `strict` upgrade. Two exceptions carry over from git: the synthesised zero-OID pointer of an unreadable ref is reported outside the catalogue, so `fsck.badRefOid` never reaches it; and `fsck.skipList` names an object-name list file, not a check, so it is never taken for a msg-id. `receive.fsck.*` and `fetch.fsck.*` are separate namespaces this command never reads.
- **Verdicts are relative to the shallow set.** In a shallow repository a
  boundary commit's parents are masked (as in git), so a "no missing objects"
  verdict does not cover ancestors beyond the `.git/shallow` cut — they are
  out of scope by construction, and a boundary commit surfaces as a `root`
  finding like any other parentless commit.
- **Non-repository is the only *structural* refusal.** `repo.fsck` calls
  `assertRepository` (not `assertOperationalRepository`): a broken `[core]`
  config or an unborn/dangling HEAD symref is tolerated, because fsck must run
  on exactly the corrupt repo you point it at. Throws `notARepository` outside
  a repo. Two *content-driven* refusals exist alongside it — see
  [Throws](#throws) below.
- **In-repo faults are findings, never throws — with two documented
  exceptions.** Every read call inside the scan is wrapped; a thrown
  `TsgitError` is classified to a finding by its `.data.code`, and fsck
  survives the worst repo state. The first exception is `connectivityOnly:
  true` against an unreachable object whose stored header cannot be recovered
  at all, or whose loose file is empty or unopenable: there git itself aborts
  (`die()`, exit 128), and tsgit rejects instead of resolving. The second is a malformed `remote.<n>.promisor` value
  — checked once, only when the run has at least one root or an
  absent-ref-target fault to walk, exactly where git's own promisor-config
  load happens (see [Throws](#throws)). A pack window read landing past the
  pack's own end — a truncated `.pack`, or a corrupt `.idx` offset pointing
  beyond it — loads as empty bytes rather than raising a raw allocation
  error; the entry-header parse then fails in the ordinary structured way
  (`INVALID_PACK_ENTRY`), which this classification degrades to a
  `dangling`/`'unknown'` finding (warned as `pack entry unreadable`) exactly
  like any other corrupt entry, never an abort. A full run also verifies each packed
  entry's CRC against its `.idx` (`pack-crc-mismatch`, `index CRC mismatch`) and unpacks it
  (`pack-entry-unpackable`, `cannot unpack`); both set bit 1 under git 2.56. A corrupt entry
  stays pack-held and is never reported `missing`, with one exception: a delta base that
  fails to unpack and that a delta child in the same pack could not read as its base is
  reported `missing`, as git does, unless a loose copy or another pack still serves it.
- **A loose object `read_loose_object` refuses, or whose hash disagrees with
  its path, is never typed — unless a pack holds a copy.** Matching git's
  `fsck_loose`, which returns before `parse_object_buffer` ever runs: an
  unreferenced object like this is reported for its content only (the
  `bad-object` / `hash-mismatch` finding above), never as a `dangling` or
  `unreachable` line of its own; a *referenced* one is instead reported
  `missing <type>` — the type read from the referencing edge, no
  `broken-link` finding alongside it, and exit bit 2 set. `--connectivity-only`
  keeps its own handling (see [Throws](#throws)). This whole rule is itself
  gated by git's `has_object_pack`: it never fires for an id a pack also
  claims, because `check_object` trusts the pack's claim and never attempts
  the read that would learn the loose copy is corrupt. Three consequences
  follow, all pinned against real git: a referenced corrupt **packed** entry
  is never reported `missing`; a tag whose target is present but unreadable
  still reports `tagged`; and a bad loose file shadowing a good packed copy
  is typed from the pack, not refused.
- **A malformed `core.bigFileThreshold` is read as absent, not refused.**
  git treats it as fatal; tsgit falls back to the 512 MiB default instead,
  the same precedent already set for `core.packedGitLimit` and
  `core.deltaBaseCacheLimit`.
- **Exit code carries severity, not exception — outside that one case.** A
  repo with missing or corrupt objects returns a non-zero `exitCode` in a
  successfully-resolved `FsckResult` — it does **not** reject, except for the
  `connectivityOnly` reject described above. The `exitCode` is a composite
  bitmask:

  | Value | Meaning |
  |---|---|
  | `0` | Clean (or only dangling/unreachable/INFO-WARN content findings). |
  | `1` | Content ERROR, `--strict`-upgraded WARN, corrupt object, hash-mismatch, or any pack, pack-index, reverse-index, bitmap, multi-pack-index or packed-entry fault (bit 1). git 2.56 folds all of them into bit 1; the bits 4, 32, 64 and 128 of earlier gits no longer exist. |
  | `2` | Missing object, broken link, or ref→absent OID (bit 2). |
  | `3` | Bits 1 and 2 combined (e.g. corrupt object whose absence also breaks a link). |
  | `8` | Malformed ref content (`badRefContent`), a symbolic ref whose referent git rejects (`badReferentName`) or an unreadable loose ref file (`cannotReadRef`), both `bad-ref` findings, the end of git's refs walk on a symlinked ref it cannot resolve (`refs-verify-ended`), a `refs` root it cannot open (`refs-walk-failed`), **or** an index cache-tree entry whose tree OID fails to resolve (no finding — see "The cache-tree check is a whole-repository condition" below). Independent causes; either alone, or both together, reads as bit 8. |
  | `10` | Bits 2 and 8 combined (e.g. malformed ref content + ref→absent OID, or a broken cache-tree alongside an unrelated missing object). |
  | `11` | Bits 1, 2 and 8 combined (e.g. an inaccessible pack beside a missing object and a bad ref). |
  | `16` | `git commit-graph verify` reported a disagreement for some object source's commit-graph file or chain (bit 16, `commit-graph-invalid`). |

  Combinations follow bitwise OR. Caller passes `result.exitCode` to
  `process.exit` to reproduce git's exit behaviour.

- **Dangling vs unreachable.** `unreachable` = objects present but not
  reachable from any root. `dangling` = the subset of unreachable objects that
  have no in-edge from another present object (the tips of unreachable
  subgraphs), matching git's distinction. Both exit 0.
- **Roots.** By default: all refs, reflog OIDs (`reflogRoots: true`), and index
  blob OIDs (`indexRoot: true`) — plus, when the index carries a cache-tree
  (`TREE` extension), each entry's resolvable tree OID. Refs that point at
  absent OIDs are reported as `bad-ref` and excluded from the root set to
  avoid spurious `missing` findings.
- **The cache-tree check is a whole-repository condition, not a finding.**
  When `indexRoot` is not `false` and the index carries a cache-tree, every
  entry's tree OID is resolved; if any fails, exit bit 8 is set — with **no
  corresponding finding** in `findings`, unlike every other exit bit. This
  cause is independent of `checkReferences`/`badRefContent` (the other bit-8
  cause, below) and of ref/reflog health: a broken ref beside a healthy
  cache-tree never sets it, and a healthy ref beside a broken cache-tree still
  does. An absent index, or one with no cache-tree extension, contributes
  nothing — a bare or never-staged repository is not a fault.
- **`--strict` upgrade.** Only the WARN-class msg-ids are affected:
  `fullPathname`, `hasDot`, `hasDotdot`, `hasDotgit`,
  `largePathname`, `nulInCommit`, `nullSha1`, `zeroPaddedFilemode`. ERROR-class
  ids (`treeNotSorted`, `missingSpaceBeforeEmail`, …) and INFO-class ids are
  unchanged by `--strict`.
- **Object-content validation** (`connectivityOnly: false`, the default) runs
  git's complete named msg-id catalogue including `.gitmodules` and
  `.gitattributes` blob-content checks (`gitmodulesUrl`, `gitmodulesParse`,
  `gitattributesLineLength`, …) and `badDateOverflow` on overflowing
  commit/tag dates.
- **The `.git`/`.gitmodules`/`.gitattributes`/`.gitignore`/`.mailmap` name
  checks fold aliases the way git does, not a literal-byte match.**
  `hasDotgit`, `gitmodulesSymlink`, `gitmodulesBlob`, `gitattributesSymlink`,
  `gitattributesBlob`, `gitignoreSymlink` and `mailmapSymlink` each compare the
  entry name through git's `is_hfs_dotgit` / `is_ntfs_dotgit` fold before
  testing it against the literal: every HFS-ignorable code point (U+200C–
  U+200F, U+202A–U+202E, U+206A–U+206F, U+FEFF) is dropped at any position,
  the NTFS 8.3 short-name and stream-suffix forms (`git~1`, `gitmod~1`…`~4`,
  each optionally followed by trailing dots/spaces) are recognised, and the
  comparison is case-insensitive — so `.GIT`, `git~1` and a mark-obfuscated
  `.git` all report `hasDotgit`, not only the exact lower-case name. The fold
  applies only to these seven alias checks; the duplicate key, the sort key
  and the length count (`duplicateEntries`, `treeNotSorted`, `largePathname`)
  stay raw-byte comparisons, matching how git compares those.
- **Oid width follows the repository's hash algorithm.** A commit's `tree` and
  `parent` lines, a tag's `object` line, and a tree entry's binary sha are only
  well-formed at the width `extensions.objectFormat` declares — 40 hex (20
  bytes) under SHA-1, 64 hex (32 bytes) under SHA-256. The other algorithm's
  width is corruption, not a tolerated variant: a 40-hex tree pointer is a
  truncated oid in a SHA-256 repository, and a 64-hex one is over-long in a
  SHA-1 repository. Both raise `badTreeSha1` / `badParentSha1` /
  `badObjectSha1` at ERROR severity (exit bit 1). git reaches the same verdict
  by a different route — the object fails to parse before its content checks
  run, so git prints `bogus commit object` instead of a msg-id — so the
  agreement to rely on is the finding and the exit bit, not the message text.
- **Refs-verify pass** (`checkReferences: true`, the default) validates loose
  and packed-refs content, producing `bad-ref` findings for `badRefContent`
  (exit bit 8) and ref→absent-OID pointers (exit bit 2). Composite exit 10
  when both classes fire on the same run.
- **Storage-agnostic.** Dangling/unreachable detection is identical for loose
  and packed objects. Content validation is too: the five tree-structure
  checks (`treeNotSorted`, `duplicateEntries`, `hasDot`, `hasDotdot`,
  `fullPathname`) fire on a packed tree exactly as they do on a loose one —
  validation reads a packed object's own pre-parse bytes rather than
  re-serializing a parsed `Tree` (which would re-sort entries and could
  report a false `hash-mismatch` against an unsorted tree).

## Examples

```ts
import { openRepository } from 'tsgit';

const repo = await openRepository({ cwd: '/path/to/repo' });

// Basic integrity check
const result = await repo.fsck();
if (result.exitCode === 0) {
  console.log('Repository is clean');
} else {
  for (const f of result.findings) {
    if (f.type === 'missing') console.error(`missing ${f.objectType} ${f.id}`);
    if (f.type === 'bad-object') console.error(`${f.severity} in ${f.objectType} ${f.id}: ${f.msgId}`);
  }
}

// Reconstruct git's output lines from findings
for (const f of result.findings) {
  if (f.type === 'dangling')
    console.log(`dangling ${f.objectType} ${f.id}`);          // stdout — objectType may be 'unknown' (connectivityOnly)
  if (f.type === 'missing')
    console.log(`missing ${f.objectType} ${f.id}`);           // stdout
  if (f.type === 'bad-object')
    console.error(`${f.severity === 'error' ? 'error' : 'warning'} in ${f.objectType} ${f.id}: ${f.msgId}: …`);  // stderr
  if (f.type === 'bad-ref')
    console.error(`error: ${f.ref}: ${f.msgId}: …`);          // stderr
}

// Connectivity-only (faster, skips content validation)
const connectivity = await repo.fsck({ connectivityOnly: true });

// Strict mode — WARN-class findings become errors
const strict = await repo.fsck({ strict: true });

// Exclude reflog roots (reachability from refs only)
const noReflog = await repo.fsck({ reflogRoots: false });

// Skip the refs-verify pass
const noRefs = await repo.fsck({ checkReferences: false });

// Pass exit code to the process
process.exit(result.exitCode);
```

## Throws

- `NOT_A_REPOSITORY` — `cwd` (or `gitDir`) does not point inside a git repository.
- `FSCK_UNKNOWN_MSG_ID` / `CONFIG_INVALID_ENUM_VALUE` — an `[fsck]` entry names a msg-id no check reports, or a severity outside `error` / `warn` / `ignore`. Either refuses the whole audit before a single object is read, as git does.
- `FSCK_CANNOT_DEMOTE` — an `[fsck]` entry asks `nulInHeader` or `unterminatedHeader` for `warn` or `ignore`. git marks both fatal: they accept `error` alone, and anything softer refuses the whole audit before a single object is read.
- `CONFIG_MISSING_VALUE` — an `[fsck]` entry names `skipList` with no value. git reads that key as a pathname, which has no valueless form, so the whole audit refuses.
- `FSCK_SKIP_LIST_UNREADABLE` / `FSCK_SKIP_LIST_INVALID_NAME` — the object-name list `fsck.skipList` names could not be opened, or one of its lines is not a full object name (an abbreviation included). Both refuse the whole audit before a single object is read, as git does. The list itself silences only the per-object **content** findings for the oids it names; a listed oid still reports as `missing`, `dangling`, `hash-mismatch` or corrupt.
- `CONFIG_BAD_ZLIB_LEVEL` / `CONFIG_MISSING_VALUE` / `CONFIG_BAD_BOOLEAN_VALUE` — an invalid streaming-class `[core]` entry, reached through the eager operational gate every operational command reads (see [`errors.md`](../errors.md)).
- `CONFIG_BAD_NUMERIC_VALUE` — a malformed `core.maxTreeDepth` or `core.deltaBaseCacheLimit` — the **repo-settings tier** ([`internals.md`](../primitives/internals.md#assertrepossettingsvalid)), reached structurally the moment `fsck` first enumerates or reads an object, not the eager gate above. `fsck` is the command a user reaches for when a repository is already suspect, and it still refuses to run at all against one whose `core.maxTreeDepth` (or `core.deltaBaseCacheLimit`) is malformed — matching git, which does the same. That refusal does not deadlock: `config --get` / `config --set` stay on the narrower, non-eager gate and keep working against the same repository, so `config --set core.maxTreeDepth <n>` is the recovery path. Separately: `fsck` itself does **not** check tree depth — `git fsck --strict` exits 0 on a repository containing a 2049-deep tree, and tsgit matches.
- `DECOMPRESS_FAILED` — `connectivityOnly: true` only, and only for an object
  that is not reachable from any root: the object is loose, its zlib stream
  cannot be inflated, and no other pack holds a readable copy of the same id.
  Reproduces git's `die()` on the same fault (real git exits 128 with no
  output); the promise rejects instead of resolving, discarding every finding
  already computed for the run. The other two modes (the default and
  `full: false`) report the same object as a `bad-object` finding with exit
  bit 1 instead of throwing.
- `INVALID_OBJECT_HEADER` — same gating as `DECOMPRESS_FAILED`, for a loose
  object whose zlib stream inflates but whose `<type> <size>\0` header cannot
  be parsed (longer than 32 bytes, an unrecognised type name, or a
  non-numeric size). Not triggered by a header that parses but disagrees with
  the body's actual size — that object still resolves normally, as a
  `dangling` / `unreachable` finding carrying its real type.
- `LOOSE_OBJECT_CORRUPT` — `connectivityOnly: true` only, and only for an
  unreachable object whose loose file yields no bytes to inflate: an empty
  file, or one the store refuses to open (mode 000). git 2.56 dies on it
  (`fatal: loose object <oid> (stored in <path>) is corrupt`, exit 128) where
  git 2.55 printed `dangling unknown`; the promise rejects with `.data.id`
  naming the object. git prints that one fatal for all three loose faults
  under `connectivityOnly`; tsgit keeps one code per cause: this one for an
  empty or unopenable file, `DECOMPRESS_FAILED` for bytes that do not
  inflate, `INVALID_OBJECT_HEADER` for a header that does not parse. A reachable unreadable loose object stays silent, and the
  default mode keeps reporting it as a `bad-object` finding with exit bit 1.
- `CONFIG_BAD_BOOLEAN_VALUE` — a `remote.<n>.promisor` entry holds a value
  git's boolean grammar refuses. Checked once per run, only when there is at
  least one root or an absent-ref-target fault to walk — a run with nothing
  to walk never reads the key, matching git.

## See also

- Primitives: [`readObject`](../primitives/read-object.md), [`enumerateObjects`](../primitives/internals.md#enumerateobjects), [`walkCommits`](../primitives/walk-commits.md)
- Related commands: [`catFile`](cat-file.md), [`revParse`](rev-parse.md)
- ADRs: [627](../../adr/627-boolean-config-values-are-refused-as-git-refuses-them.md), [907](../../adr/907-whole-object-loose-reads-bound-the-inflate-to-the-size-claim.md) (amended 2026-09-28 for the commit/tree/tag hash-path parity, `core.bigFileThreshold`, and the never-typed/`has_object_pack` rule above)
