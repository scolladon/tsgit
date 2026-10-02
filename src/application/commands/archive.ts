import type { ArchiveEntry, ArchiveResult } from '../../domain/archive/index.js';
import { resolveAttribute } from '../../domain/attributes/index.js';
import { NO_PARSER_OFFSET, validateIndexPath } from '../../domain/git-index/path-validator.js';
import { unexpectedObjectType } from '../../domain/objects/error.js';
import { FILE_MODE } from '../../domain/objects/file-mode.js';
import type { FileMode, FilePath, ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { readBlobContentInStreamOrder } from '../primitives/internal/blob-source.js';
import { peel } from '../primitives/internal/peel.js';
import { buildTreeAttributeProvider } from '../primitives/internal/read-gitattributes.js';
import { getObjectStore } from '../primitives/object-store.js';
import { readBlob } from '../primitives/read-blob.js';
import { readDeclaredObjectHeader, readObject } from '../primitives/read-object.js';
import type { WalkTreeEntry } from '../primitives/types.js';
import { walkTree } from '../primitives/walk-tree.js';
import { assertOperationalRepository } from './internal/repo-state.js';
import { revParse } from './rev-parse.js';

export type { ArchiveEntry, ArchiveResult } from '../../domain/archive/index.js';

/** Options for the `archive` command. */
export interface ArchiveOptions {
  /**
   * Tree-ish to export (branch name, tag, commit oid, tree oid …).
   * Required — `git archive` refuses with no argument.
   */
  readonly treeish: string;
}

/**
 * Resolve a tree-ish and return a structured entry stream — the data equivalent
 * of `git archive`. No tar/zip bytes are produced here; serializers are separate
 * pure functions that consume an `ArchiveResult`.
 *
 * Refusal conditions (thrown, never mid-stream):
 * - `NOT_A_REPOSITORY`: `ctx` does not point at a git repository.
 * - Unborn HEAD or unresolvable expression: propagated from `revParse`.
 * - `UNEXPECTED_OBJECT_TYPE`: treeish resolves to a blob, not a tree/commit/tag.
 */
export async function archive(ctx: Context, opts: ArchiveOptions): Promise<ArchiveResult> {
  await assertOperationalRepository(ctx);
  const oid = await revParse(ctx, opts.treeish);
  const classified = await classifyOid(ctx, oid);
  const { tree } = classified;
  if ('commit' in classified) {
    const { commit, commitTime } = classified;
    return { tree, commit, commitTime, entries: buildEntryStream(ctx, tree) };
  }
  return { tree, entries: buildEntryStream(ctx, tree) };
}

// ---------------------------------------------------------------------------
// internal helpers
// ---------------------------------------------------------------------------

/** Classify result when the treeish resolves through a commit (direct or via tag). */
interface CommitClassify {
  readonly tree: ObjectId;
  readonly commit: ObjectId;
  readonly commitTime: number;
}

/** Classify result when the treeish is a bare tree object. */
interface TreeClassify {
  readonly tree: ObjectId;
}

type ClassifyResult = CommitClassify | TreeClassify;

/** Peel oid to its tree, extracting commit oid + committer timestamp when present. */
async function classifyOid(ctx: Context, oid: ObjectId): Promise<ClassifyResult> {
  const obj = await readObject(ctx, oid);
  if (obj.type === 'commit') {
    return { tree: obj.data.tree, commit: oid, commitTime: obj.data.committer.timestamp };
  }
  if (obj.type === 'tag') {
    const commitOid = await peel(ctx, oid, 'commit');
    const commitObj = await readObject(ctx, commitOid);
    if (commitObj.type !== 'commit') {
      throw unexpectedObjectType('commit', commitObj.type, commitOid);
    }
    return {
      tree: commitObj.data.tree,
      commit: commitOid,
      commitTime: commitObj.data.committer.timestamp,
    };
  }
  if (obj.type === 'tree') {
    return { tree: oid };
  }
  // git refuses a blob treeish with "fatal: not a tree object"
  throw unexpectedObjectType('tree', obj.type, oid);
}

const isRegularFileMode = (mode: FileMode): boolean =>
  mode === FILE_MODE.REGULAR || mode === FILE_MODE.EXECUTABLE;

/**
 * git's archive streams a regular blob above `core.bigFileThreshold` and reads
 * every other entry whole, so only the former is opened in stream order.
 */
async function readEntryContent(ctx: Context, id: ObjectId, mode: FileMode): Promise<Uint8Array> {
  if (isRegularFileMode(mode)) {
    const { type, declaredSize } = await readDeclaredObjectHeader(ctx, id);
    const { bigFileThreshold } = await getObjectStore(ctx);
    if (type === 'blob' && declaredSize > bigFileThreshold) {
      return readBlobContentInStreamOrder(ctx, id);
    }
  }
  return (await readBlob(ctx, id)).content;
}

/**
 * Lazy async generator over all tree entries in pre-order (dir before contents).
 * git archive imposes no entry cap — pass an effectively-unbounded maxEntries
 * so walkTree's diff-oriented default never aborts a large tree. Depth is left
 * at walkTree's own default: git caps archive's depth exactly like every
 * other traversal (`git archive --format=tar` on a tree past
 * `core.maxTreeDepth` exits 128), so no override belongs here.
 * Blob content is hydrated per-entry as the caller iterates; no upfront
 * materialisation of the full tree.
 *
 * `walkTree` never validates entry names — a raw tree can carry a `.`/`..`
 * or traversal-shaped name that reaches neither the index nor a filesystem
 * write, since archive only serializes bytes. Each entry's path is
 * validated here, before it is yielded as a tar/zip member name, so the
 * refusal fires at the same boundary git's own `archive` refuses it.
 */
async function* buildEntryStream(ctx: Context, tree: ObjectId): AsyncIterable<ArchiveEntry> {
  const plan = await createEntryPlanner(ctx, tree);
  for await (const entry of walkTree(ctx, tree, {
    maxEntries: Number.MAX_SAFE_INTEGER,
  })) {
    validateIndexPath(entry.path, NO_PARSER_OFFSET, entry.mode);
    yield* await plan(entry);
  }
}

const EXPORT_IGNORE = 'export-ignore';

/** `export-ignore` counts only when set — a string value or an unset is kept. */
const createExportIgnoreCheck = async (
  ctx: Context,
  tree: ObjectId,
): Promise<(key: string) => Promise<boolean>> => {
  const provider = await buildTreeAttributeProvider(ctx, tree);
  return async (key) => {
    const { sources, macros } = await provider.sourcesForPath(key as FilePath);
    return resolveAttribute(sources, key, EXPORT_IGNORE, macros) === true;
  };
};

const isInside = (path: string, directory: string): boolean => path.startsWith(`${directory}/`);

const attributeKey = (path: string, mode: FileMode): string =>
  mode === FILE_MODE.GITLINK ? `${path}/` : path;

/**
 * git's `queue_or_write_archive_entry`: a directory is held back until a
 * non-directory descendant reaches its own export-ignore check, so a directory
 * with nothing left to export is never emitted. The directory is flushed
 * before that check, which is why `dir/**` keeps `dir` itself.
 */
const createEntryPlanner = async (
  ctx: Context,
  tree: ObjectId,
): Promise<(entry: WalkTreeEntry) => Promise<ReadonlyArray<ArchiveEntry>>> => {
  const isExportIgnored = await createExportIgnoreCheck(ctx, tree);
  let queued: ArchiveEntry[] = [];
  let ignoredDirectory: string | undefined;
  return async ({ path, id, mode }) => {
    if (ignoredDirectory !== undefined && isInside(path, ignoredDirectory)) return [];
    queued = queued.filter((dir) => isInside(path, dir.path));
    if (mode === FILE_MODE.DIRECTORY) {
      if (await isExportIgnored(`${path}/`)) ignoredDirectory = path;
      else queued.push({ path, mode, oid: id });
      return [];
    }
    const flushed = queued;
    queued = [];
    if (await isExportIgnored(attributeKey(path, mode))) return flushed;
    if (mode === FILE_MODE.GITLINK) return [...flushed, { path, mode, oid: id }];
    return [...flushed, { path, mode, oid: id, content: await readEntryContent(ctx, id, mode) }];
  };
};
