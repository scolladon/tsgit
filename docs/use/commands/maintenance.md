# `maintenance`

Explicit-only invocation of tsgit-managed repository upkeep — git's
`git maintenance run`, minus the timer and the `--auto` threshold gate. There
is no background scheduler, no threshold check inside `status`, and no
write-path hook: a caller decides when maintenance happens, and only the
tasks it names run.

Ships two tasks. `commit-graph` writes `objects/info/commit-graph`
byte-identical to `git commit-graph write --reachable` for the same commit
set. `gc` consolidates every pack it owns, by class: **all** reachable,
non-promisor objects — loose *and* already packed — repack into one fresh
normal pack; every promisor object repacks whole into one fresh promisor
pack, never merged with the normal one; and unreachable, non-promisor
objects route through git's cruft-pack lifecycle wherever they lived: recent
unreachable objects survive in a cruft pack carrying a `.mtimes` age
sidecar; objects aged past `gc.pruneExpire` are destroyed outright.
**`gc` is the first tsgit command that can permanently destroy data** — read
the expiry section below before relying on it. `*.keep`-marked packs are
git's own escape hatch from all of this — see below.

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
  /** The promisor pack's sha, or `undefined` when no promisor object is
   *  owned before or after this run — the common, non-partial-clone case. */
  readonly promisorPackId: string | undefined;
  /** Superseded packs deleted by this call — normal, cruft and promisor combined. */
  readonly packsRetired: number;
  /** Summed `.pack` bytes in `objects/pack/` before the call. */
  readonly packBytesBefore: number;
  /** The same sum after the call. */
  readonly packBytesAfter: number;
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
2. **Every pack `gc` owns is classified** by its sibling markers before
   anything is written — the SAME rule git applies:
   - `*.keep` → **kept**, totally excluded: not read for repacking, not
     rewritten, not deleted, and its objects are neither duplicated into the
     new pack nor migrated to the cruft pack even when unreachable. This is
     the caller's escape hatch from every rule below.
   - `.promisor` → a **second, disjoint consolidation class**: every
     promisor object repacks whole into **one** freshly written promisor
     pack (`promisorPackId`), reachability irrelevant, and is **never**
     merged with the normal pack — a partial clone's lazily-fetchable
     objects must never read as fully present locally.
   - `.mtimes` → the existing **cruft** pack, governed by step 4 below.
   - anything else → **normal**, consolidated by step 3.
3. **Reachable, non-promisor objects** — loose *and* already packed, across
   every normal pack — repack into **one** freshly written normal pack
   (`packId`). Every superseded normal pack and its siblings
   (`.idx`/`.pack`/`.rev`/`.bitmap`) are deleted. No pack is written when
   nothing is reachable outside kept and promisor packs (`packId:
   undefined`), never an empty one — and there is deliberately **no**
   "already consolidated, skip it" shortcut: even a single unchanged pack is
   rewritten on every run (same sha, since the packer is deterministic),
   because a pack's own file mtime is the age an object carries the moment
   it later becomes unreachable — a skipped rewrite would silently
   stale-date that clock. The promisor pack (previous bullet) is rewritten
   on the identical no-skip schedule, and its superseded siblings — now
   including `.promisor` — are deleted the same way.
4. **Unreachable objects** go through the cruft-pack lifecycle
   (`gc.cruftPacks`, default `true`), regardless of whether they came from a
   loose file or a pack being consolidated away:
   - An object's age is the **newest** of up to three sources: the loose
     file's own mtime, a carried-forward `.mtimes` sidecar entry, and — new
     under consolidation — the mtime of the NORMAL pack it is migrating out
     of. Never the wall clock.
   - Objects whose age is **more recent** than the cutoff derived from
     `gc.pruneExpire` (default `2.weeks.ago`; accepts `never`, `now`,
     `@<epoch>`, ISO-8601, `<n>.<unit>.ago`) survive in a cruft pack carrying
     a `.mtimes` sidecar. `never` keeps everything; `now` destroys
     everything and skips writing a cruft pack at all.
   - Objects at or older than the cutoff (`mtime <= cutoff`, a strict
     boundary) are **destroyed** — the one operation in this command that
     permanently removes data.
   - A rerun that changes nothing rewrites nothing: the existing cruft
     pack's bytes and file name are left exactly as they are, even while the
     normal packs around it are being consolidated.
5. **`gc.cruftPacks=false`** skips the cruft pack entirely: surviving
   unreachable objects are written back out as ordinary loose files instead
   — including one whose only prior copy lived inside a normal pack about to
   be superseded — while aged-out ones are still destroyed with the pack
   that held them. Any existing cruft pack is retired.
6. **A multi-pack-index naming a retired pack is deleted.** tsgit has no
   midx writer, so deletion is the only available response; a midx naming
   only surviving kept packs is left untouched.
7. **`auto: true`** applies the `gc.auto` gate before any of the above runs:
   below the threshold (default 6700 loose objects), `gc` is skipped
   entirely and `tasksRun` omits `'gc'`. `gc.auto=0` disables the gate — `gc`
   always runs. `auto` absent or `false` runs unconditionally, exactly as an
   explicit `git gc` ignores `gc.auto`.
8. **Refs, reflogs and the index are never touched.** `gc` packs objects
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
| `promisorPackId` | the promisor pack's sha, or `undefined` when no promisor object is owned before or after this run |
| `packsRetired` | superseded packs deleted this run, normal, cruft and promisor combined — `packsAfter − packsBefore` cannot express this, since consolidating five packs into one and consolidating two into one both read `−1` |
| `packBytesBefore` / `packBytesAfter` | summed `.pack` bytes in `objects/pack/`, before and after — the denominator and numerator of the size trade below |

- **No rendered text.** Every field is a count, a boolean, an enum member or
  an object id; a caller composing a summary line ("packed 42 objects into 1
  pack") does so itself.
- **Three pack ids, read as one set.** An ordinary repository reports
  `packId` set and `cruftPackId`/`promisorPackId` `undefined`; a partial
  clone with no garbage reports `packId` and `promisorPackId` set,
  `cruftPackId` undefined; a repository whose only pack is `*.keep`-marked
  reports all three `undefined` — that is not an error, just nothing to
  consolidate.

### Object placement by file class

| Object class | Where it ends up |
|---|---|
| reachable, loose or already packed | the one new normal pack |
| unreachable, newer than the expiry cutoff | the cruft pack, `.mtimes` intact |
| unreachable, at or past the cutoff | **destroyed** |
| in a normal pack, since become unreachable | migrates to the cruft pack, carrying its SOURCE pack's mtime |
| anything inside a `*.keep` pack | untouched — never repacked, never crufted, never duplicated |
| anything inside a `.promisor` pack, reachable or not | the one new promisor pack, marker carried; never merged with the normal pack, never crufted, never destroyed |

### The size trade

tsgit's pack writer emits every object as a full base entry — it does not
write delta chains. Consolidating a repository that git had delta-compressed
therefore **inflates** it: re-emitting an existing delta chain's objects as
base entries costs more bytes than the chain did. Measured brackets: **×1.29**
on content that barely deltifies to begin with, up to **×6.91** on a
deliberately deep 43-level delta chain; **×3.17** on tsgit's own real
history is the number to plan against. The trade is accepted, not gated —
`packBytesBefore`/`packBytesAfter` make it observable, and a delta-writing
pack writer is the natural follow-up that retires it. `*.keep` a pack to opt
it out of consolidation entirely if the inflation is unacceptable for that
content.

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
  [731](../../adr/731-gc-uses-cruft-packs.md),
  [732](../../adr/732-gc-consolidates-existing-packs.md),
  [733](../../adr/733-gc-repacks-promisor-objects-separately.md)
