import type { IndexEntry } from '../../domain/git-index/index.js';
import type { ObjectId, RefName } from '../../domain/objects/index.js';
import type { FilePath } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import { readIndex } from '../primitives/read-index.js';
import { createGranularityTracker } from './internal/progress-tracker.js';
import { assertRepository, readHeadRaw } from './internal/repo-state.js';
import { readFile, validatePath } from './internal/working-tree.js';

export type ChangeKind = 'modified' | 'added' | 'deleted' | 'untracked';

export interface ChangeEntry {
  readonly kind: ChangeKind;
  readonly path: FilePath;
}

export interface StatusResult {
  readonly branch: RefName | undefined;
  readonly detached: boolean;
  readonly indexChanges: ReadonlyArray<ChangeEntry>;
  readonly workingTreeChanges: ReadonlyArray<ChangeEntry>;
  readonly clean: boolean;
}

const STATUS_SCAN_OP = 'status:scan';
const STATUS_SCAN_GRANULARITY = 100;

/**
 * Summarize the state of the working tree relative to the index, and the
 * branch HEAD points at. Working-tree-vs-HEAD diff (Git's "staged" column)
 * is approximated via index-vs-working-tree comparisons until Phase 11
 * adds the stat-cache fast path.
 *
 * Progress reporting (Phase 10 §6.2): emits `status:scan` start before the
 * fan-out, updates at every 100 lstat completions, and end in a finally
 * block so the consumer always pairs start with end. `total` is undefined
 * — design choice that prevents revealing repository size to non-trusted
 * progress sinks.
 */
export const status = async (ctx: Context): Promise<StatusResult> => {
  await assertRepository(ctx);
  const head = await readHeadRaw(ctx);
  const branch = head.kind === 'symbolic' ? head.target : undefined;
  const detached = head.kind === 'direct';
  const index = await readIndex(ctx).catch(() => ({ entries: [] as ReadonlyArray<IndexEntry> }));
  const indexByPath = new Map<FilePath, IndexEntry>();
  for (const entry of index.entries) indexByPath.set(entry.path, entry);
  ctx.progress.start(STATUS_SCAN_OP);
  try {
    const tracker = createGranularityTracker(ctx.progress, STATUS_SCAN_OP, STATUS_SCAN_GRANULARITY);
    // Independent file checks — fan out so I/O overlaps. Order is preserved by Map insertion + Promise.all.
    const settled = await Promise.all(
      Array.from(indexByPath).map(async ([path, entry]) => {
        const result = await classifyEntry(ctx, path, entry);
        tracker.tick();
        return result;
      }),
    );
    // status:scan reports indeterminate progress (total undefined per design §6.2),
    // so no final-flush — only bucket-crossing updates fire.
    const workingTreeChanges = settled.filter((c): c is ChangeEntry => c !== undefined);
    const clean = workingTreeChanges.length === 0;
    return {
      branch,
      detached,
      indexChanges: [],
      workingTreeChanges,
      clean,
    };
  } finally {
    ctx.progress.end(STATUS_SCAN_OP);
  }
};

const classifyEntry = async (
  ctx: Context,
  path: FilePath,
  entry: IndexEntry,
): Promise<ChangeEntry | undefined> => {
  const stat = await ctx.fs.lstat(`${ctx.layout.workDir}/${path}`).catch(() => undefined);
  if (stat === undefined) return { kind: 'deleted', path };
  if (await isModified(ctx, path, entry)) return { kind: 'modified', path };
  return undefined;
};

const HEADER_ENCODER = new TextEncoder();

const isModified = async (ctx: Context, path: FilePath, entry: IndexEntry): Promise<boolean> => {
  try {
    const bytes = await readFile(ctx, validatePath(path));
    // Hash the blob bytes WITHOUT persisting — `status` is a read-only query.
    const header = HEADER_ENCODER.encode(`blob ${bytes.byteLength}\0`);
    const buf = new Uint8Array(header.byteLength + bytes.byteLength);
    buf.set(header, 0);
    buf.set(bytes, header.byteLength);
    const tempId = (await ctx.hash.hashHex(buf)) as ObjectId;
    return tempId !== entry.id;
  } catch {
    return true;
  }
};
