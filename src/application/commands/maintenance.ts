/**
 * Tier-1 `maintenance` command — explicit-only invocation of tsgit-managed
 * repository upkeep (git's `git maintenance run`, minus the timer and the
 * `--auto` threshold gate). Never auto-triggered: no timer, no threshold
 * check inside `status`, no write-path hook — a caller decides when
 * maintenance happens, and only the tasks it names run.
 *
 * Ships two tasks. `commit-graph` writes `objects/info/commit-graph`.
 * `gc` packs reachable loose objects into a normal pack and routes
 * unreachable ones through git's cruft-pack lifecycle: recent unreachable
 * objects survive in a cruft pack carrying a `.mtimes` sidecar, objects aged
 * past `gc.pruneExpire` are destroyed. Existing packs beyond an existing
 * cruft pack are not touched by this task — that is a later task's
 * consolidation.
 */
import { invalidOption } from '../../domain/commands/error.js';
import type { ObjectId } from '../../domain/objects/index.js';
import type { PackIndexWriterEntry } from '../../domain/storage/index.js';
import type { Context } from '../../ports/context.js';
import { buildPack } from '../primitives/build-pack.js';
import { assertValidGcAutoConfig, readConfig } from '../primitives/config-read.js';
import { enumerateObjects } from '../primitives/enumerate-objects.js';
import { expiryCutoff } from '../primitives/expiry-cutoff.js';
import { assertValidBooleanConfig } from '../primitives/internal/boolean-config-guard.js';
import { type ClosureTier, computeClosure } from '../primitives/internal/closure-engine.js';
import { boundedMapFor } from '../primitives/internal/concurrency.js';
import {
  computeCruftMtimes,
  decideCruftFate,
  declassifyCruftPack,
  readExistingCruftPack,
  retireCruftPack,
  writeCruftPack,
} from '../primitives/internal/cruft-pack-lifecycle.js';
import { errorDataCode } from '../primitives/internal/error-data-code.js';
import { forgetLooseOidPrefix } from '../primitives/internal/loose-oid-cache.js';
import { writePackArtifacts } from '../primitives/internal/write-pack-artifacts.js';
import { forgetParsedObjectMemo } from '../primitives/object-resolver.js';
import { commonGitDir, looseObjectPath, packsDir } from '../primitives/path-layout.js';
import { getPackRegistry, readObject, refreshPackRegistry } from '../primitives/read-object.js';
import { writeCommitGraph } from '../primitives/write-commit-graph.js';
import { writeObject } from '../primitives/write-object.js';
import { collectRetentionRoots } from './internal/fsck/roots.js';
import { assertOperationalRepository } from './internal/repo-state.js';

export type MaintenanceTask = 'commit-graph' | 'gc';

export interface MaintenanceOptions {
  readonly tasks: ReadonlyArray<MaintenanceTask>;
  /**
   * Mirrors `git maintenance run --auto`: gates the `gc` task on
   * `gc.auto` (default 6700 loose objects; `0` disables the gate). Absent
   * or `false` runs `gc` unconditionally, exactly as an explicit `git gc`
   * ignores `gc.auto` entirely. Has no effect on `commit-graph`.
   */
  readonly auto?: boolean;
}

export interface MaintenanceResult {
  readonly tasksRun: ReadonlyArray<MaintenanceTask>;
  readonly commitGraphWritten: boolean;
  readonly commitsInGraph: number;
  readonly looseObjectsBefore: number;
  readonly looseObjectsPacked: number;
  readonly prunedLooseObjects: number;
  readonly packsBefore: number;
  readonly packsAfter: number;
  /** The normal pack's sha, or `undefined` when no reachable object was packed. */
  readonly packId: ObjectId | undefined;
  readonly cruftObjectsAdded: number;
  readonly cruftObjectsRetained: number;
  readonly cruftObjectsExpired: number;
  /** The cruft pack's sha, or `undefined` when no cruft pack exists afterward. */
  readonly cruftPackId: ObjectId | undefined;
}

const KNOWN_TASKS: ReadonlySet<MaintenanceTask> = new Set(['commit-graph', 'gc']);
const DEFAULT_GC_AUTO_THRESHOLD = 6700;
const DEFAULT_PRUNE_EXPIRE = '2.weeks.ago';
const CLOSURE_TIER: ClosureTier = 'walk';

const validateTasks = (tasks: ReadonlyArray<MaintenanceTask>): void => {
  if (tasks.length === 0) throw invalidOption('tasks', 'at least one task required');
  for (const task of tasks) {
    if (!KNOWN_TASKS.has(task)) throw invalidOption('tasks', `'${task}' is not a valid task`);
  }
};

const runCommitGraphTask = async (
  ctx: Context,
): Promise<Pick<MaintenanceResult, 'commitGraphWritten' | 'commitsInGraph'>> => {
  const { commitCount } = await writeCommitGraph(ctx);
  return { commitGraphWritten: commitCount > 0, commitsInGraph: commitCount };
};

type GcResult = Omit<MaintenanceResult, 'tasksRun' | 'commitGraphWritten' | 'commitsInGraph'>;

const GC_NOT_RUN: GcResult = {
  looseObjectsBefore: 0,
  looseObjectsPacked: 0,
  prunedLooseObjects: 0,
  packsBefore: 0,
  packsAfter: 0,
  packId: undefined,
  cruftObjectsAdded: 0,
  cruftObjectsRetained: 0,
  cruftObjectsExpired: 0,
  cruftPackId: undefined,
};

/**
 * `auto: true` consults `gc.auto` (git default 6700; `0` disables the
 * gate — the threshold check never declines). `auto` absent/false always
 * runs, mirroring explicit `git gc` ignoring `gc.auto` entirely.
 */
async function shouldDeclineForAuto(
  ctx: Context,
  auto: boolean | undefined,
  looseCount: number,
): Promise<boolean> {
  if (auto !== true) return false;
  await assertValidGcAutoConfig(ctx);
  const threshold = (await readConfig(ctx)).gc?.auto ?? DEFAULT_GC_AUTO_THRESHOLD;
  if (threshold === 0) return false;
  return looseCount <= threshold;
}

async function computeReachableSet(ctx: Context): Promise<ReadonlySet<ObjectId>> {
  const roots = await collectRetentionRoots(ctx);
  const closure = await computeClosure(ctx, {
    wants: [...roots],
    not: [],
    objects: true,
    tier: CLOSURE_TIER,
  });
  return new Set(closure.objects.map((object) => object.id));
}

function partitionOwned(
  owned: ReadonlySet<ObjectId>,
  reachable: ReadonlySet<ObjectId>,
): {
  readonly toNormalPack: ReadonlyArray<ObjectId>;
  readonly cruftCandidates: ReadonlyArray<ObjectId>;
} {
  const toNormalPack: ObjectId[] = [];
  const cruftCandidates: ObjectId[] = [];
  for (const id of owned) {
    (reachable.has(id) ? toNormalPack : cruftCandidates).push(id);
  }
  return { toNormalPack, cruftCandidates };
}

function partitionByCutoff(
  candidates: ReadonlyArray<ObjectId>,
  mtimes: ReadonlyMap<ObjectId, number>,
  cutoff: number,
): { readonly survivors: ReadonlyArray<ObjectId>; readonly doomed: ReadonlyArray<ObjectId> } {
  const survivors: ObjectId[] = [];
  const doomed: ObjectId[] = [];
  for (const id of candidates) {
    const mtime = mtimes.get(id) as number;
    (mtime > cutoff ? survivors : doomed).push(id);
  }
  return { survivors, doomed };
}

function indexEntriesFor(
  oids: ReadonlyArray<ObjectId>,
  entries: ReadonlyArray<{ readonly crc32: number; readonly offset: number }>,
): ReadonlyArray<PackIndexWriterEntry> {
  return oids.map((id, i) => ({ id, crc32: entries[i]!.crc32, offset: entries[i]!.offset }));
}

interface NormalPackOutcome {
  readonly packId: ObjectId | undefined;
  /** True when the resulting pack's sha is byte-identical to the existing
   *  cruft pack's — a resurrected object whose entire cruft set moves
   *  intact into the normal pack reproduces the exact same bytes
   *  (`buildPack` is deterministic), so the file already on disk under
   *  that name IS the normal pack now; it must be de-classified (its
   *  `.mtimes` sidecar dropped), never retired as garbage. */
  readonly reusesExistingCruftPack: boolean;
}

/** Skipped entirely (`packId: undefined`) when `oids` is empty — git writes
 *  no pack rather than a zero-object one. */
async function buildAndWriteNormalPack(
  ctx: Context,
  packDir: string,
  oids: ReadonlyArray<ObjectId>,
  existingCruftPackSha: string | undefined,
): Promise<NormalPackOutcome> {
  if (oids.length === 0) return { packId: undefined, reusesExistingCruftPack: false };
  const pack = await buildPack(ctx, { oids });
  if (pack.sha === existingCruftPackSha) {
    return { packId: pack.sha as ObjectId, reusesExistingCruftPack: true };
  }
  const written = await writePackArtifacts(ctx, {
    packDir,
    packBytes: pack.bytes,
    entries: indexEntriesFor(oids, pack.entries),
    packSha: pack.sha,
    promisor: false,
  });
  return { packId: written.packSha as ObjectId, reusesExistingCruftPack: false };
}

async function buildAndWriteCruftPack(
  ctx: Context,
  packDir: string,
  survivors: ReadonlyArray<ObjectId>,
  mtimes: ReadonlyMap<ObjectId, number>,
): Promise<ObjectId> {
  const pack = await buildPack(ctx, { oids: survivors });
  const written = await writeCruftPack(ctx, {
    packDir,
    entries: indexEntriesFor(survivors, pack.entries),
    packBytes: pack.bytes,
    packSha: pack.sha,
    mtimeOf: (id) => mtimes.get(id) as number,
  });
  return written.packSha as ObjectId;
}

/** Writes a surviving-but-not-loose object (carried only in the retiring
 *  cruft pack) back out as an ordinary loose file — the `gc.cruftPacks=false`
 *  write-back path. A no-op when the object is already loose. */
async function loosenIfNotLoose(
  ctx: Context,
  id: ObjectId,
  looseSet: ReadonlySet<ObjectId>,
): Promise<void> {
  if (looseSet.has(id)) return;
  await writeObject(ctx, await readObject(ctx, id));
}

interface CruftOutcome {
  readonly cruftPackId: ObjectId | undefined;
  readonly retireOldCruft: boolean;
}

/**
 * Physically executes the cruft pack's fate. `gc.cruftPacks=false` bypasses
 * the pack entirely: survivors are written back loose (when not already),
 * and any existing cruft pack is unconditionally retired — no cruft pack
 * may exist afterward under that setting.
 */
async function applyCruftOutcome(
  ctx: Context,
  packDir: string,
  cruftPacksEnabled: boolean,
  survivors: ReadonlyArray<ObjectId>,
  existingCruft: {
    readonly mtimes: ReadonlyMap<ObjectId, number>;
    readonly packSha: string | undefined;
  },
  looseSet: ReadonlySet<ObjectId>,
  mtimes: ReadonlyMap<ObjectId, number>,
): Promise<CruftOutcome> {
  if (!cruftPacksEnabled) {
    await boundedMapFor(ctx, 'ioBound', survivors, (id) => loosenIfNotLoose(ctx, id, looseSet));
    return { cruftPackId: undefined, retireOldCruft: existingCruft.packSha !== undefined };
  }

  const existingCruftKeys = new Set(existingCruft.mtimes.keys());
  const fate = decideCruftFate(survivors, existingCruftKeys);
  if (fate === 'noop') {
    return { cruftPackId: existingCruft.packSha as ObjectId | undefined, retireOldCruft: false };
  }
  if (fate === 'delete') {
    return { cruftPackId: undefined, retireOldCruft: existingCruft.packSha !== undefined };
  }
  const cruftPackId = await buildAndWriteCruftPack(ctx, packDir, survivors, mtimes);
  return { cruftPackId, retireOldCruft: existingCruft.packSha !== undefined };
}

function isFileNotFound(error: unknown): boolean {
  return errorDataCode(error) === 'FILE_NOT_FOUND';
}

/** Loose oids that already resolve through the (just-refreshed) pack
 *  registry — reachable ones just packed, survivors just crufted, and any
 *  loose file that happened to duplicate a pre-existing pack's object
 *  ("prune-packable" in git's `count-objects -v` naming). */
async function packedAnywhere(
  ctx: Context,
  looseSet: ReadonlySet<ObjectId>,
): Promise<ReadonlySet<ObjectId>> {
  const registry = getPackRegistry(ctx);
  const looseArray = [...looseSet];
  const hits = await boundedMapFor(ctx, 'ioBound', looseArray, async (id) =>
    (await registry.lookup(id)) !== undefined ? id : undefined,
  );
  return new Set(hits.filter((id): id is ObjectId => id !== undefined));
}

async function pruneLooseFiles(ctx: Context, ids: ReadonlySet<ObjectId>): Promise<void> {
  const gitDir = commonGitDir(ctx);
  for (const id of ids) {
    try {
      await ctx.fs.rm(looseObjectPath(gitDir, id));
    } catch (error) {
      if (!isFileNotFound(error)) throw error;
    }
    forgetLooseOidPrefix(ctx, id);
  }
}

interface RunGcOptions {
  readonly auto: boolean | undefined;
}

async function runGcTask(
  ctx: Context,
  opts: RunGcOptions,
): Promise<{ readonly ran: boolean; readonly result: GcResult }> {
  const packDir = packsDir(commonGitDir(ctx));
  const packsBefore = (await getPackRegistry(ctx).all()).length;

  const looseIds = await enumerateObjects(ctx, { includePacks: false });
  const looseSet = new Set(looseIds);
  const looseObjectsBefore = looseIds.length;

  if (await shouldDeclineForAuto(ctx, opts.auto, looseObjectsBefore)) {
    return {
      ran: false,
      result: { ...GC_NOT_RUN, looseObjectsBefore, packsBefore, packsAfter: packsBefore },
    };
  }

  await assertValidBooleanConfig(ctx, 'gc', undefined, ['cruftPacks']);
  const config = await readConfig(ctx);
  const cruftPacksEnabled = config.gc?.cruftPacks ?? true;
  const cutoff = expiryCutoff(config.gc?.pruneExpire ?? DEFAULT_PRUNE_EXPIRE, {});

  const existingCruft = await readExistingCruftPack(ctx);
  const owned = new Set<ObjectId>([...looseSet, ...existingCruft.mtimes.keys()]);
  const reachable = await computeReachableSet(ctx);
  const { toNormalPack, cruftCandidates } = partitionOwned(owned, reachable);

  const mtimes = await computeCruftMtimes(ctx, cruftCandidates, looseSet, existingCruft.mtimes);
  const { survivors, doomed } = partitionByCutoff(cruftCandidates, mtimes, cutoff);

  // --- every write starts here; every refusal above leaves the store untouched ---
  const normalPack = await buildAndWriteNormalPack(
    ctx,
    packDir,
    toNormalPack,
    existingCruft.packSha,
  );
  const cruftOutcome = await applyCruftOutcome(
    ctx,
    packDir,
    cruftPacksEnabled,
    survivors,
    existingCruft,
    looseSet,
    mtimes,
  );

  refreshPackRegistry(ctx);
  const verifyTargets = [...toNormalPack, ...survivors];
  await boundedMapFor(ctx, 'ioBound', verifyTargets, (id) =>
    readObject(ctx, id, { verifyHash: true }),
  );

  const packed = await packedAnywhere(ctx, looseSet);
  const doomedSet = new Set(doomed);
  const unlink = new Set<ObjectId>(packed);
  for (const id of doomedSet) if (looseSet.has(id)) unlink.add(id);
  await pruneLooseFiles(ctx, unlink);

  // Every doomed object is truly gone from the store from this point on —
  // drop it from the byte cache and the parsed-object memo too, or a
  // destroyed object would keep reading back successfully from a cache
  // neither of which has any concept of an object having been removed.
  for (const id of doomedSet) {
    ctx.deltaCache.delete(id);
    forgetParsedObjectMemo(ctx, id);
  }

  if (cruftOutcome.retireOldCruft && existingCruft.packSha !== undefined) {
    await getPackRegistry(ctx).settleRefresh();
    if (normalPack.reusesExistingCruftPack) {
      await declassifyCruftPack(ctx, packDir, existingCruft.packSha);
    } else {
      await retireCruftPack(ctx, packDir, existingCruft.packSha);
    }
  }

  refreshPackRegistry(ctx);
  const packsAfter = (await getPackRegistry(ctx).all()).length;

  const existingCruftKeys = new Set(existingCruft.mtimes.keys());
  const cruftObjectsAdded = survivors.filter((id) => !existingCruftKeys.has(id)).length;
  const cruftObjectsRetained = survivors.filter((id) => existingCruftKeys.has(id)).length;

  return {
    ran: true,
    result: {
      looseObjectsBefore,
      looseObjectsPacked: packed.size,
      prunedLooseObjects: unlink.size,
      packsBefore,
      packsAfter,
      packId: normalPack.packId,
      cruftObjectsAdded,
      cruftObjectsRetained,
      cruftObjectsExpired: doomed.length,
      cruftPackId: cruftOutcome.cruftPackId,
    },
  };
}

export const maintenance = async (
  ctx: Context,
  opts: MaintenanceOptions,
): Promise<MaintenanceResult> => {
  await assertOperationalRepository(ctx);
  validateTasks(opts.tasks);

  const runsCommitGraph = opts.tasks.includes('commit-graph');
  const runsGc = opts.tasks.includes('gc');

  const commitGraphOutcome = runsCommitGraph
    ? await runCommitGraphTask(ctx)
    : { commitGraphWritten: false, commitsInGraph: 0 };
  const gcOutcome = runsGc
    ? await runGcTask(ctx, { auto: opts.auto })
    : { ran: false, result: GC_NOT_RUN };

  const tasksRun: MaintenanceTask[] = [];
  if (runsCommitGraph) tasksRun.push('commit-graph');
  if (gcOutcome.ran) tasksRun.push('gc');

  return { tasksRun, ...commitGraphOutcome, ...gcOutcome.result };
};
