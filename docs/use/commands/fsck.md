# `fsck`

Verify object integrity and connectivity in the repository — the structured
equivalent of `git fsck`. Returns **structured data only**: each problem is a
typed `FsckFinding` variant carrying the object IDs, severity, and msg-id
needed to reconstruct git's `error in <type> <sha>: …` / `warning in …` output
(see ADR-249: the library ships findings as data, the caller renders them).

## Signature

```ts
repo.fsck(opts?: FsckOptions): Promise<FsckResult>;

type FsckObjectType = 'commit' | 'blob' | 'tree' | 'tag';
type FsckSeverity   = 'error' | 'warning' | 'info';

type FsckFinding =
  | { readonly type: 'dangling';     readonly id: ObjectId; readonly objectType: FsckObjectType }
  | { readonly type: 'unreachable';  readonly id: ObjectId; readonly objectType: FsckObjectType }
  | { readonly type: 'missing';      readonly id: ObjectId; readonly objectType: FsckObjectType | 'unknown' }
  | { readonly type: 'broken-link';  readonly fromId: ObjectId; readonly fromType: FsckObjectType;
                                     readonly toId: ObjectId;   readonly toType: FsckObjectType | 'unknown' }
  | { readonly type: 'bad-object';   readonly id: ObjectId; readonly objectType: FsckObjectType;
                                     readonly msgId: string; readonly severity: FsckSeverity }
  | { readonly type: 'hash-mismatch'; readonly id: ObjectId; readonly actual: ObjectId }
  | { readonly type: 'bad-ref';      readonly ref: RefName; readonly msgId: string;
                                     readonly severity: FsckSeverity; readonly target?: ObjectId }
  | { readonly type: 'root';         readonly id: ObjectId }
  | { readonly type: 'tagged';       readonly id: ObjectId; readonly objectType: FsckObjectType;
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
| `connectivityOnly` | `boolean` | `false` | Skip object-content validation (git's `--connectivity-only`); only check that linked objects exist. |
| `reflogRoots` | `boolean` | `true` | Treat reflog OIDs as reachability roots (git's default). Set `false` to exclude reflogs. |
| `indexRoot` | `boolean` | `true` | Treat index blob OIDs as reachability roots (git's default). Set `false` to exclude the index. |
| `full` | `boolean` | `true` | Include pack objects (git's `--full`). Set `false` to scan loose objects only. |
| `strict` | `boolean` | `false` | Upgrade WARN-class msg-ids to ERROR and set exit bit 1 (git's `--strict`). |
| `checkReferences` | `boolean` | `true` | Run the `git refs verify` ref-content pass; malformed ref content produces `bad-ref` findings with exit bit 8. |

## Behaviour

- **Non-repository is the only refusal.** `repo.fsck` calls `assertRepository`
  (not `assertOperationalRepository`): a broken `[core]` config or an
  unborn/dangling HEAD symref is tolerated, because fsck must run on exactly
  the corrupt repo you point it at. Throws `notARepository` outside a repo.
- **In-repo faults are findings, never throws.** Every read call inside the
  scan is wrapped; a thrown `TsgitError` is classified to a finding by its
  `.data.code`. fsck survives the worst repo state.
- **Exit code carries severity.** A repo with missing or corrupt objects
  returns a non-zero `exitCode` in a successfully-resolved `FsckResult` — it
  does **not** reject. Composite bitmask: bit 1 = content ERROR / hash-mismatch
  / corrupt; bit 2 = missing / broken-link; bit 8 = refs-verify content
  failure. Values 0, 1, 2, 3, 8, 10, 11 are in use.
- **Dangling vs unreachable.** `unreachable` = objects present but not
  reachable from any root. `dangling` = the subset of unreachable objects that
  have no in-edge from another present object (the tips of unreachable
  subgraphs), matching git's distinction.
- **Roots.** By default: all refs, reflog OIDs (`reflogRoots: true`), and index
  blob OIDs (`indexRoot: true`). Refs that point at absent OIDs are reported as
  `bad-ref` and excluded from the root set to avoid spurious `missing` findings.
- **`--strict` upgrade.** Only WARN-class msg-ids are affected
  (`zeroPaddedFilemode`, `duplicateEntries`, `emptyName`, …). ERROR-class
  (`treeNotSorted`, `missingSpaceBeforeEmail`, …) and INFO-class ids are
  unchanged.

### Caller projections (the library ships data, not rendering)

Reconstruct git's output lines from the structured findings:

```ts
// git's "error in <type> <sha>: <msgId>: <description>"
const renderBadObject = (f: Extract<FsckFinding, { type: 'bad-object' }>) =>
  `${f.severity === 'error' ? 'error' : 'warning'} in ${f.objectType} ${f.id}: ${f.msgId}`;

// git's "missing <type> <sha>"
const renderMissing = (f: Extract<FsckFinding, { type: 'missing' }>) =>
  `missing ${f.objectType} ${f.id}`;

// git's "dangling <type> <sha>"
const renderDangling = (f: Extract<FsckFinding, { type: 'dangling' }>) =>
  `dangling ${f.objectType} ${f.id}`;

// exit code → process.exit(result.exitCode)
```

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

// Connectivity-only check (faster, skips content validation)
const connectivity = await repo.fsck({ connectivityOnly: true });

// Strict mode — WARN-class findings become errors
const strict = await repo.fsck({ strict: true });

// Skip reflog roots (check reachability from refs only)
const noReflog = await repo.fsck({ reflogRoots: false });

// Skip the refs-verify pass
const noRefs = await repo.fsck({ checkReferences: false });
```

## Throws

- `NOT_A_REPOSITORY` — `cwd` (or `gitDir`) does not point inside a git repository.

## See also

- Primitives: [`readObject`](../primitives/read-object.md), [`walkCommits`](../primitives/walk-commits.md)
- Related commands: [`catFile`](cat-file.md), [`revParse`](rev-parse.md)
