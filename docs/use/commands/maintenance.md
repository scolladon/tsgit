# `maintenance`

Explicit-only invocation of tsgit-managed repository upkeep — git's
`git maintenance run`, minus the timer and the `--auto` threshold gate. There
is no background scheduler, no threshold check inside `status`, and no
write-path hook: a caller decides when maintenance happens, and only the
tasks it names run.

Currently ships the `commit-graph` task, which writes
`objects/info/commit-graph` byte-identical to
`git commit-graph write --reachable` for the same commit set. Additional
tasks (`gc`) land in a later release; requesting an unlisted task is a
refusal, not a silent no-op.

## Signature

```ts
repo.maintenance(options: MaintenanceOptions): Promise<MaintenanceResult>;

type MaintenanceTask = 'commit-graph';

interface MaintenanceOptions {
  readonly tasks: ReadonlyArray<MaintenanceTask>;
}

interface MaintenanceResult {
  readonly tasksRun: ReadonlyArray<MaintenanceTask>;
  readonly commitGraphWritten: boolean;
  readonly commitsInGraph: number;
}
```

## Behaviour

- **`tasks` is required and non-empty.** An empty array or an unknown task
  name refuses with `INVALID_OPTION` — mirroring
  `git maintenance run --task=bogus` → `error: 'bogus' is not a valid task`.
- **`tasksRun` echoes what actually ran.** In this release it always equals
  the requested `tasks` — every listed task runs unconditionally, since
  there is no `auto` gate yet to decline one.
- **`commit-graph`** sources commits from every resolvable ref (the same
  root set as `git commit-graph write --reachable`), writes
  `objects/info/commit-graph`, and reports:
  - `commitGraphWritten` — `true` only when the graph holds at least one
    commit. A repository with no commits still runs the task (`tasksRun`
    includes `'commit-graph'`) but reports `commitGraphWritten: false` —
    "ran and found nothing" stays distinguishable from "declined."
  - `commitsInGraph` — the number of commits the graph now holds.
- **No rendered text.** Every field is a count, a boolean or an enum member;
  a caller composing a summary line does so itself.

## Examples

```ts
// Write a fresh commit-graph over every ref this repository can see.
const { tasksRun, commitGraphWritten, commitsInGraph } = await repo.maintenance({
  tasks: ['commit-graph'],
});

// An unknown task refuses rather than running nothing silently.
await repo.maintenance({ tasks: ['bogus' as never] }); // throws INVALID_OPTION
```

## Throws

- `NOT_A_REPOSITORY` — `ctx` does not point at an initialized repository.
- `INVALID_OPTION` — `tasks` is empty, or names a task tsgit does not
  recognise.
- `RESOURCE_LOCKED` — another writer holds `objects/info/commit-graph.lock`.

## See also

- Related commands: [`packObjects`](pack-objects.md), [`packRefs`](pack-refs.md)
- ADRs: [724](../../adr/724-maintenance-command-with-commit-graph-and-gc-lite.md)
