# `maintenance`

Explicit-only invocation of tsgit-managed repository upkeep — git's
`git maintenance run`, minus the timer and the `--auto` threshold gate. There
is no background scheduler, no threshold check inside `status`, and no
write-path hook: a caller decides when maintenance happens, and only the
tasks it names run.

Ships two tasks. `commit-graph` writes `objects/info/commit-graph`
byte-identical to `git commit-graph write --reachable` for the same commit
set. `gc` packs every reachable loose object into a normal pack and routes
unreachable ones through git's cruft-pack lifecycle: recent unreachable
objects survive in a cruft pack carrying a `.mtimes` age sidecar; objects
aged past `gc.pruneExpire` are destroyed outright. **`gc` is the first tsgit
command that can permanently destroy data** — read the expiry section below
before relying on it. Existing packs beyond an existing cruft pack are not
touched by this task; consolidating them is a later task's job.

## Signature

```ts
repo.maintenance(options: MaintenanceOptions): Promise<MaintenanceResult>;

type MaintenanceTask = 'commit-graph' | 'gc';

interface MaintenanceOptions {
  readonly tasks: ReadonlyArray<MaintenanceTask>;
  /** Gates the `gc` task on `gc.auto` (default 6700 loose objects; `0`
   *  disables the gate). Absent or `false` runs `gc` unconditionally,
   *  mirroring explicit `git gc` ignoring `gc.auto` entirely — only
   *  `git gc --auto` consults it. Has no effect on `commit-graph`. */
  readonly auto?: boolean;
}

interface MaintenanceResult {
  readonly tasksRun: ReadonlyArray<MaintenanceTask>;
  readonly commitGraphWritten: boolean;
  readonly commitsInGraph: number;
  readonly looseObjectsBefore: number;
  readonly looseObjectsPacked: number;
  readonly prunedLooseObjects: number;
  readonly packsBefore: number;
  readonly packsAfter: number;
  /** The normal pack's sha, or `undefined` when no reachable object was packed. */
  readonly packId: string | undefined;
  readonly cruftObjectsAdded: number;
  readonly cruftObjectsRetained: number;
  readonly cruftObjectsExpired: number;
  /** The cruft pack's sha, or `undefined` when no cruft pack exists afterward. */
  readonly cruftPackId: string | undefined;
}
```

## Behaviour

- **`tasks` is required and non-empty.** An empty array or an unknown task
  name refuses with `INVALID_OPTION` — mirroring
  `git maintenance run --task=bogus` → `error: 'bogus' is not a valid task`.
- **`tasksRun` echoes what actually ran.** Only a requested task runs;
  `'gc'` is additionally omitted when the `auto` gate declines it (see
  below) — the caller tells "declined" from "ran and found nothing" by
  reading `tasksRun`, never a separate flag.
- **`commit-graph`** sources commits from every resolvable ref (the same
  root set as `git commit-graph write --reachable`), writes
  `objects/info/commit-graph`, and reports:
  - `commitGraphWritten` — `true` only when the graph holds at least one
    commit. A repository with no commits still runs the task (`tasksRun`
    includes `'commit-graph'`) but reports `commitGraphWritten: false` —
    "ran and found nothing" stays distinguishable from "declined."
  - `commitsInGraph` — the number of commits the graph now holds.

### `gc` — the object lifecycle

1. **Reachability.** Roots are every resolvable ref plus `HEAD`, the index,
   and every reflog — wider than `commit-graph`'s refs-only root set,
   matching git's own `gc`. A commit reachable only from a deleted branch's
   reflog, or a blob staged but never committed, survives.
2. **Reachable objects** — loose or already packed — land in one freshly
   written normal pack (`packId`). No pack is written when nothing is
   reachable-and-loose (`packId: undefined`), never an empty one.
3. **Unreachable objects** go through the cruft-pack lifecycle
   (`gc.cruftPacks`, default `true`):
   - An object's age is its **source file's own mtime** — the loose file's,
     or, when carried forward from an existing cruft pack, that sidecar's
     recorded value — taking the **newer** of the two when both exist (a
     rewritten object's age resets, exactly as git "freshens" it). Never the
     wall clock.
   - Objects whose age is **more recent** than the cutoff derived from
     `gc.pruneExpire` (default `2.weeks.ago`; accepts `never`, `now`,
     `@<epoch>`, ISO-8601, `<n>.<unit>.ago`) survive in a cruft pack carrying
     a `.mtimes` sidecar. `never` keeps everything; `now` destroys
     everything and skips writing a cruft pack at all.
   - Objects at or older than the cutoff (`mtime <= cutoff`, a strict
     boundary) are **destroyed** — the one operation in this command that
     permanently removes data.
   - A rerun that changes nothing rewrites nothing: the existing cruft
     pack's bytes and file name are left exactly as they are.
4. **`gc.cruftPacks=false`** skips the cruft pack entirely: surviving
   unreachable objects are written back out as ordinary loose files instead
   (any existing cruft pack is retired), while aged-out ones are still
   destroyed.
5. **`auto: true`** applies the `gc.auto` gate before any of the above runs:
   below the threshold (default 6700 loose objects), `gc` is skipped
   entirely and `tasksRun` omits `'gc'`. `gc.auto=0` disables the gate — `gc`
   always runs. `auto` absent or `false` runs unconditionally, exactly as an
   explicit `git gc` ignores `gc.auto`.
6. **Refs, reflogs and the index are never touched.** `gc` packs objects
   only — no `pack-refs`, no `reflog expire`. Pack a repository's refs with
   [`packRefs`](pack-refs.md) as a separate, explicit call.

`MaintenanceResult`'s gc fields:

| Field | Meaning |
|---|---|
| `looseObjectsBefore` | loose objects present when `gc` started |
| `looseObjectsPacked` | loose objects that ended up in a pack (normal or cruft) |
| `prunedLooseObjects` | every loose file unlinked — packed ones and destroyed ones alike, so it may exceed `looseObjectsPacked` |
| `packsBefore` / `packsAfter` | pack count before and after the call |
| `packId` | the normal pack's sha, or `undefined` |
| `cruftObjectsAdded` | newly-unreachable objects that entered the cruft pack this run |
| `cruftObjectsRetained` | objects carried forward from the previous cruft pack, ages intact |
| `cruftObjectsExpired` | objects **destroyed** by the expiry cutoff — the one count that means data left the repository forever |
| `cruftPackId` | the cruft pack's sha, or `undefined` when none exists afterward |

- **No rendered text.** Every field is a count, a boolean, an enum member or
  an object id; a caller composing a summary line ("packed 42 objects into 1
  pack") does so itself.

## Examples

```ts
// Write a fresh commit-graph over every ref this repository can see.
const { tasksRun, commitGraphWritten, commitsInGraph } = await repo.maintenance({
  tasks: ['commit-graph'],
});

// Pack reachable objects and cruft the rest, unconditionally.
const gcResult = await repo.maintenance({ tasks: ['gc'] });

// Same, but only when loose-object count exceeds gc.auto.
const declined = await repo.maintenance({ tasks: ['gc'], auto: true });
// declined.tasksRun omits 'gc' when the threshold was not exceeded.

// An unknown task refuses rather than running nothing silently.
await repo.maintenance({ tasks: ['bogus' as never] }); // throws INVALID_OPTION
```

## Throws

- `NOT_A_REPOSITORY` — `ctx` does not point at an initialized repository.
- `INVALID_OPTION` — `tasks` is empty, or names a task tsgit does not
  recognise.
- `RESOURCE_LOCKED` — another writer holds `objects/info/commit-graph.lock`.
- `CONFIG_BAD_NUMERIC_VALUE` — `gc.auto` fails git's integer grammar (only
  checked under `auto: true`).
- `CONFIG_BAD_BOOLEAN_VALUE` — `gc.cruftPacks` fails git's boolean grammar.
- `CONFIG_BAD_DATE_VALUE` — `gc.pruneExpire` fails the supported date
  grammar. `gc` writes nothing when this refusal fires.
- `INVALID_CRUFT_MTIMES` — the existing cruft pack's `.mtimes` sidecar
  disagrees with its `.idx` on object count, or fails its self-checksum.
  `gc` writes nothing when this refusal fires.

## See also

- Related commands: [`packObjects`](pack-objects.md), [`packRefs`](pack-refs.md)
- ADRs: [724](../../adr/724-maintenance-command-with-commit-graph-and-gc-lite.md),
  [731](../../adr/731-gc-uses-cruft-packs.md)
