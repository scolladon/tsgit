import { walkWorkingTree } from '../../application/primitives/walk-working-tree.js';
import { operationAborted } from '../../domain/error.js';
import type { FileMode } from '../../domain/objects/file-mode.js';
import { matchesPathspec } from '../../domain/pathspec/index.js';
import type { WorkdirEntryRow, WorkdirStat } from '../../domain/snapshot/index.js';
import type { Context } from '../../ports/context.js';
import type { FileStat } from '../../ports/file-system.js';
import type {
  WalkIgnorePredicate,
  WorkdirEnumerator,
  WorkdirEnumOptions,
} from '../../ports/snapshot-resolvers.js';

const deriveFileMode = (stat: FileStat): FileMode =>
  stat.isSymbolicLink ? '120000' : (stat.mode & 0o111) !== 0 ? '100755' : '100644';

const toWorkdirStat = (stat: FileStat): WorkdirStat => ({
  mode: deriveFileMode(stat),
  size: stat.size,
  mtimeMs: stat.mtimeMs,
  ...(stat.mtimeNs === undefined ? {} : { mtimeNs: stat.mtimeNs }),
  ino: BigInt(stat.ino),
});

const toRow = (path: WorkdirEntryRow['path'], stat: FileStat): WorkdirEntryRow => {
  const workdirStat = toWorkdirStat(stat);
  return {
    source: 'workdir',
    path,
    mode: workdirStat.mode,
    kind: stat.isSymbolicLink ? 'symlink' : 'file',
    stat: workdirStat,
  };
};

/**
 * Working-tree enumerator (design §6.3, §10.6). Wraps the existing
 * `walkWorkingTree` primitive with the new row shape and the snapshot
 * port's option set. Pathspec and excludes compose via logical AND
 * (ADR-158): excludes prunes during traversal (cheap — applies to
 * directories too); pathspec filters at yield time (path-level only,
 * directory pruning by spec is a future optimisation).
 *
 * Cancellation honours both `ctx.signal` (walked by the underlying
 * primitive) and the optional per-call `opts.signal`. The two are
 * checked at each yield boundary; either being aborted surfaces as
 * `operationAborted()`.
 */
export const createFsWorkdirEnumerator = (): WorkdirEnumerator => ({
  enumerate: (ctx, opts) => enumerate(ctx, opts),
});

async function* enumerate(ctx: Context, opts: WorkdirEnumOptions): AsyncIterable<WorkdirEntryRow> {
  const isAborted = (): boolean => opts.signal?.aborted === true || ctx.signal?.aborted === true;
  if (isAborted()) throw operationAborted();
  const excludes: WalkIgnorePredicate | undefined = opts.excludes;
  const inner = walkWorkingTree(ctx, {
    ...(opts.maxDepth === undefined ? {} : { maxDepth: opts.maxDepth }),
    ...(opts.maxEntries === undefined ? {} : { maxEntries: opts.maxEntries }),
    ...(excludes === undefined ? {} : { ignore: excludes }),
  });
  for await (const { path, stat } of inner) {
    if (isAborted()) throw operationAborted();
    if (opts.paths !== undefined && !matchesPathspec(opts.paths, path)) continue;
    yield toRow(path, stat);
  }
}
