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
      readonly severity: FsckSeverity; readonly target?: ObjectId }
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
  | { readonly type: 'midx-unusable';
      readonly artefact: string; readonly reason: string }
  | { readonly type: 'midx-checksum-mismatch';
      readonly artefact: string }
  | { readonly type: 'midx-pack-unresolved';
      readonly artefact: string; readonly position: number; readonly pack: string }
  | { readonly type: 'midx-entry-unresolved';
      readonly artefact: string; readonly id: ObjectId };

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
| `indexRoot` | `boolean` | `true` | Treat index blob OIDs as reachability roots (git's default). Set `false` to exclude the index. |
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
| `missing` | `id`, `objectType` (`FsckObjectType \| 'unknown'`) | Referenced object absent from store. Exit bit 2. |
| `broken-link` | `fromId`, `fromType`, `toId`, `toType` (`FsckObjectType \| 'unknown'`) | Edge from a present object to an absent one. Exit bit 2. |
| `bad-object` | `id`, `objectType` (`FsckObjectType \| 'unknown'`), `msgId`, `severity` | Object-content validation failure from the named msg-id catalogue, or corrupt/undecodable object. Exit bit 1 (ERROR-class or `--strict`-upgraded). `objectType` is `'unknown'` when the object is undecodable and its type cannot be determined. |
| `hash-mismatch` | `id`, `actual` | File content hashes to `actual`; file's path implies `id`. Exit bit 1. |
| `bad-ref` | `ref`, `msgId`, `severity`, `target?` | Refs-verify pass finding: malformed ref content (`badRefContent` — exit bit 8) or ref pointing at an absent/zero OID (`badRefOid` / *invalid sha1 pointer* — exit bit 2). `target` is present when the ref had a syntactically-valid OID target. |
| `root` | `id` | Root commit (no parents). Emitted when the caller filters for `type === 'root'`. Exit 0. |
| `tagged` | `id`, `objectType`, `tagName`, `tag` | Tag target: `id` is the tagged object, `tag` is the tag object OID. Emitted when the caller filters for `type === 'tagged'`. Exit 0. |
| `pack-inaccessible` | `pack`, `reason` | A pack failed the header gate — bad version, bad signature, truncated file, a header/index object-count disagreement, or a `.pack` that could not be opened. Full mode only (suppressed by `full: false` or `connectivityOnly: true`). Exit bit 4. |
| `pack-index-unusable` | `pack`, `reason` | A pack's `.idx` could not be read or parsed. Full mode only; always accompanied by a `pack-rev-index-unusable` finding for the same pack. Exit bit 4. |
| `pack-rev-index-unusable` | `pack`, `reason` | A pack's index is unusable, so no reverse index can be derived from it either. Emitted in **every** mode, including `connectivityOnly` and `full: false` — unlike the other two pack findings, this one is not mode-gated. Exit bit 64. |
| `midx-unusable` | `artefact`, `reason` | The multi-pack-index (or a chain layer) actually in use was discarded — too small, unreadable, a chunk offset outside the file, a hash-version mismatch, with no usable fallback layer — or the entry-resolution walk hit a structural fault reached only inside this pass. `artefact` names the file; `reason` is tsgit's own wording, not reconstructed from git's stderr. A dropped chain that still leaves a usable layer, or a discarded flat file rescued by a loadable chain, produces no finding. Reported in every mode. Exit bit 32. |
| `midx-checksum-mismatch` | `artefact` | The in-use artefact's trailer digest disagrees with its declared content — checked once per `fsck` run, on the flat file or the chain head only (never a base layer), and never on the ordinary read path. Reported in every mode. Exit bit 32. |
| `midx-pack-unresolved` | `artefact`, `position`, `pack` | A `PNAM` entry — `position` is its chain-global index — names a pack that could not be resolved this scan, and whose `.pack` file is also gone. Reported in every mode. Exit bit 32. |
| `midx-entry-unresolved` | `artefact`, `id` | An object the midx routes to a pack that cannot serve it — fires even when the pack itself resolved (its `.pack` is on disk but its `.idx` is not), independently of `midx-pack-unresolved`. Reported in every mode. Exit bit 32. |

`pack` is the pack's base name (`pack-<sha>`), already vetted at scan time against path
separators, `..`, and control characters — but it is **not shell-safe** (spaces, quotes, `$`,
backticks survive that filter); quote it before interpolating into a shell command or composing
a path from it. `reason` is a short description of the fault; the wording is tsgit's own, not
reconstructed from git's stderr text.

## Behaviour

- **Verdicts are relative to the shallow set.** In a shallow repository a
  boundary commit's parents are masked (as in git), so a "no missing objects"
  verdict does not cover ancestors beyond the `.git/shallow` cut — they are
  out of scope by construction, and a boundary commit surfaces as a `root`
  finding like any other parentless commit.
- **Non-repository is the only *structural* refusal.** `repo.fsck` calls
  `assertRepository` (not `assertOperationalRepository`): a broken `[core]`
  config or an unborn/dangling HEAD symref is tolerated, because fsck must run
  on exactly the corrupt repo you point it at. Throws `notARepository` outside
  a repo. One *content-driven* refusal exists alongside it — see
  [Throws](#throws) below.
- **In-repo faults are findings, never throws — with one documented
  exception.** Every read call inside the scan is wrapped; a thrown
  `TsgitError` is classified to a finding by its `.data.code`, and fsck
  survives the worst repo state. The exception is `connectivityOnly: true`
  against an unreachable object whose stored header cannot be recovered at
  all: there git itself aborts (`die()`, exit 128), and tsgit rejects instead
  of resolving (see [Throws](#throws)).
- **Exit code carries severity, not exception — outside that one case.** A
  repo with missing or corrupt objects returns a non-zero `exitCode` in a
  successfully-resolved `FsckResult` — it does **not** reject, except for the
  `connectivityOnly` reject described above. The `exitCode` is a composite
  bitmask:

  | Value | Meaning |
  |---|---|
  | `0` | Clean (or only dangling/unreachable/INFO-WARN content findings). |
  | `1` | Content ERROR, `--strict`-upgraded WARN, corrupt object, or hash-mismatch (bit 1). |
  | `2` | Missing object, broken link, or ref→absent OID (bit 2). |
  | `3` | Bits 1 and 2 combined (e.g. corrupt object whose absence also breaks a link). |
  | `4` | A pack failed the header gate or `.idx` parse (bit 4, `pack-inaccessible` / `pack-index-unusable`). Full mode only — suppressed by `full: false` or `connectivityOnly: true`. |
  | `6` | Bits 2 and 4 combined (e.g. a missing object alongside an unrelated pack accessibility fault). |
  | `8` | Refs-verify content failure only (bit 8). |
  | `10` | Bits 2 and 8 combined (e.g. malformed ref content + ref→absent OID). |
  | `14` | Bits 2, 4 and 8 combined. |
  | `32` | The in-use multi-pack-index or chain layer was discarded, its trailer checksum disagreed, or it routes to a pack or entry it cannot resolve (bit 32, the four `midx-*` findings). Set in **every** mode, including `connectivityOnly` and `full: false` — ungated like bit 64, unlike bit 4. |
  | `42` | Bits 2, 8 and 32 combined (e.g. a midx-named pack fully deleted: missing objects, invalid ref pointers, and the midx's own pack-resolution failure, with no unrelated pack-accessibility fault). |
  | `64` | A pack's reverse index is unusable, no other error (bit 64, `pack-rev-index-unusable`). Set in **every** mode, including `connectivityOnly` and `full: false` — the one bit this table's other rows are gated against. |
  | `68` | Bits 4 and 64 combined — an unusable `.idx` in full mode sets both, matching git's `index not opened` **and** `unable to load rev-index` for the same pack. |
  | `110` | Bits 2, 4, 8, 32 and 64 combined — a midx-named pack's `.idx` gone sets the pack pass's bits (4 and 64) alongside the midx pass's (32), plus the ordinary connectivity fallout (2 and 8). |

  Combinations follow bitwise OR. Caller passes `result.exitCode` to
  `process.exit` to reproduce git's exit behaviour.

- **Dangling vs unreachable.** `unreachable` = objects present but not
  reachable from any root. `dangling` = the subset of unreachable objects that
  have no in-edge from another present object (the tips of unreachable
  subgraphs), matching git's distinction. Both exit 0.
- **Roots.** By default: all refs, reflog OIDs (`reflogRoots: true`), and index
  blob OIDs (`indexRoot: true`). Refs that point at absent OIDs are reported as
  `bad-ref` and excluded from the root set to avoid spurious `missing` findings.
- **`--strict` upgrade.** Only the WARN-class msg-ids are affected:
  `emptyName`, `fullPathname`, `hasDot`, `hasDotdot`, `hasDotgit`,
  `largePathname`, `nulInCommit`, `nullSha1`, `zeroPaddedFilemode`. ERROR-class
  ids (`treeNotSorted`, `missingSpaceBeforeEmail`, …) and INFO-class ids are
  unchanged by `--strict`.
- **Object-content validation** (`connectivityOnly: false`, the default) runs
  git's complete named msg-id catalogue including `.gitmodules` and
  `.gitattributes` blob-content checks (`gitmodulesUrl`, `gitmodulesParse`,
  `gitattributesLineLength`, …) and `badDateOverflow` on overflowing
  commit/tag dates.
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

## See also

- Primitives: [`readObject`](../primitives/read-object.md), [`enumerateObjects`](../primitives/internals.md#enumerateobjects), [`walkCommits`](../primitives/walk-commits.md)
- Related commands: [`catFile`](cat-file.md), [`revParse`](rev-parse.md)
