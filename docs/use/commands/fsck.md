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
      readonly id: ObjectId; readonly objectType: FsckObjectType }
  | { readonly type: 'unreachable';
      readonly id: ObjectId; readonly objectType: FsckObjectType }
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
      readonly tagName: string; readonly tag: ObjectId };

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
| `dangling` | `id`, `objectType` | Object present but reachable from no root and has no in-edge from another present object (tip of an unreachable subgraph). Exit 0. |
| `unreachable` | `id`, `objectType` | Object present but not reachable from any root (superset of `dangling`). Exit 0. |
| `missing` | `id`, `objectType` (`FsckObjectType \| 'unknown'`) | Referenced object absent from store. Exit bit 2. |
| `broken-link` | `fromId`, `fromType`, `toId`, `toType` (`FsckObjectType \| 'unknown'`) | Edge from a present object to an absent one. Exit bit 2. |
| `bad-object` | `id`, `objectType` (`FsckObjectType \| 'unknown'`), `msgId`, `severity` | Object-content validation failure from the named msg-id catalogue, or corrupt/undecodable object. Exit bit 1 (ERROR-class or `--strict`-upgraded). `objectType` is `'unknown'` when the object is undecodable and its type cannot be determined. |
| `hash-mismatch` | `id`, `actual` | File content hashes to `actual`; file's path implies `id`. Exit bit 1. |
| `bad-ref` | `ref`, `msgId`, `severity`, `target?` | Refs-verify pass finding: malformed ref content (`badRefContent` — exit bit 8) or ref pointing at an absent/zero OID (`badRefOid` / *invalid sha1 pointer* — exit bit 2). `target` is present when the ref had a syntactically-valid OID target. |
| `root` | `id` | Root commit (no parents). Emitted when the caller filters for `type === 'root'`. Exit 0. |
| `tagged` | `id`, `objectType`, `tagName`, `tag` | Tag target: `id` is the tagged object, `tag` is the tag object OID. Emitted when the caller filters for `type === 'tagged'`. Exit 0. |

## Behaviour

- **Non-repository is the only refusal.** `repo.fsck` calls `assertRepository`
  (not `assertOperationalRepository`): a broken `[core]` config or an
  unborn/dangling HEAD symref is tolerated, because fsck must run on exactly
  the corrupt repo you point it at. Throws `notARepository` outside a repo.
- **In-repo faults are findings, never throws.** Every read call inside the
  scan is wrapped; a thrown `TsgitError` is classified to a finding by its
  `.data.code`. fsck survives the worst repo state.
- **Exit code carries severity, not exception.** A repo with missing or corrupt
  objects returns a non-zero `exitCode` in a successfully-resolved `FsckResult`
  — it does **not** reject. The `exitCode` is a composite bitmask:

  | Value | Meaning |
  |---|---|
  | `0` | Clean (or only dangling/unreachable/INFO-WARN content findings). |
  | `1` | Content ERROR, `--strict`-upgraded WARN, corrupt object, or hash-mismatch (bit 1). |
  | `2` | Missing object, broken link, or ref→absent OID (bit 2). |
  | `3` | Bits 1 and 2 combined (e.g. corrupt object whose absence also breaks a link). |
  | `8` | Refs-verify content failure only (bit 8). |
  | `10` | Bits 2 and 8 combined (e.g. malformed ref content + ref→absent OID). |

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
  and packed objects.

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
    console.log(`dangling ${f.objectType} ${f.id}`);          // stdout
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

## See also

- Primitives: [`readObject`](../primitives/read-object.md), [`enumerateObjects`](../primitives/enumerate-objects.md), [`walkCommits`](../primitives/walk-commits.md)
- Related commands: [`catFile`](cat-file.md), [`revParse`](rev-parse.md)
