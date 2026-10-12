import type { ArchiveEntry, ArchiveResult } from '../../domain/archive/index.js';
import { resolveAttribute } from '../../domain/attributes/index.js';
import { NO_PARSER_OFFSET, validateIndexPath } from '../../domain/git-index/path-validator.js';
import { unexpectedObjectType } from '../../domain/objects/error.js';
import { FILE_MODE } from '../../domain/objects/file-mode.js';
import type { FileMode, FilePath, ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { readStrictBigFileThreshold } from '../primitives/internal/big-file-threshold.js';
import { readBlobContentInStreamOrder } from '../primitives/internal/blob-source.js';
import { peel } from '../primitives/internal/peel.js';
import { buildAttributeProvider } from '../primitives/internal/read-gitattributes.js';
import { readBlob } from '../primitives/read-blob.js';
import { readDeclaredObjectHeader, readObject } from '../primitives/read-object.js';
import type { WalkTreeEntry } from '../primitives/types.js';
import { walkTree } from '../primitives/walk-tree.js';
import { createSubstExpander, type SubstExpander } from './internal/archive-subst.js';
import { assertOperationalRepository } from './internal/repo-state.js';
import { dwimRefNameWarning } from './internal/revision-name.js';
import { evaluateRevision } from './rev-parse.js';

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
 * - Unborn HEAD or unresolvable expression: propagated from `evaluateRevision`.
 * - `UNEXPECTED_OBJECT_TYPE`: treeish resolves to a blob, not a tree/commit/tag.
 */
export async function archive(ctx: Context, opts: ArchiveOptions): Promise<ArchiveResult> {
  await assertOperationalRepository(ctx);
  // git's `parse_treeish_arg`: a `dwim_ref` of the whole name, then one `get_oid` read.
  await dwimRefNameWarning(ctx, opts.treeish);
  const oid = await evaluateRevision(ctx, opts.treeish);
  const classified = await classifyOid(ctx, oid);
  const { tree } = classified;
  if ('commit' in classified) {
    const { commit, commitTime } = classified;
    const entries = buildEntryStream(ctx, tree, createSubstExpander(ctx, { commit, tree }));
    return { tree, commit, commitTime, entries };
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
    const commitOid = await peel(ctx, undefined, oid, 'commit');
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

const readInCore = async (ctx: Context, id: ObjectId): Promise<Uint8Array> =>
  (await readBlob(ctx, id)).content;

/**
 * git's archive streams a regular blob above `core.bigFileThreshold` and reads
 * every other entry whole, so only the former is opened in stream order.
 */
async function readRegularContent(ctx: Context, id: ObjectId): Promise<Uint8Array> {
  const { type, declaredSize } = await readDeclaredObjectHeader(ctx, id);
  if (type !== 'blob') return readInCore(ctx, id);
  if (declaredSize > (await readStrictBigFileThreshold(ctx))) {
    return readBlobContentInStreamOrder(ctx, id);
  }
  return readInCore(ctx, id);
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
async function* buildEntryStream(
  ctx: Context,
  tree: ObjectId,
  subst?: SubstExpander,
): AsyncIterable<ArchiveEntry> {
  const plan = await createEntryPlanner(ctx, tree, subst);
  for await (const entry of walkTree(ctx, tree, {
    maxEntries: Number.MAX_SAFE_INTEGER,
  })) {
    validateIndexPath(entry.path, NO_PARSER_OFFSET, entry.mode);
    yield* await plan(entry);
  }
}

const EXPORT_IGNORE = 'export-ignore';
const EXPORT_SUBST = 'export-subst';

type AttributeCheck = (key: string, attribute: string) => Promise<boolean>;

/** An archive attribute counts only when set — a string value or an unset is not. */
const createAttributeCheck = async (ctx: Context, tree: ObjectId): Promise<AttributeCheck> => {
  const provider = await buildAttributeProvider(ctx, { kind: 'tree', tree });
  return async (key, attribute) => {
    const { sources, macros } = await provider.sourcesForPath(key as FilePath);
    return resolveAttribute(sources, key, attribute, macros) === true;
  };
};

/**
 * git's `write_archive_entry`: only a regular file is converted, and a converted
 * file is read whole whatever its size — the attribute decides, not whether a
 * commit is there to expand against.
 */
const readEntryContent = async (
  ctx: Context,
  entry: WalkTreeEntry,
  isSet: AttributeCheck,
  subst: SubstExpander | undefined,
): Promise<Uint8Array> => {
  if (!isRegularFileMode(entry.mode)) return readInCore(ctx, entry.id);
  if (!(await isSet(entry.path, EXPORT_SUBST))) return readRegularContent(ctx, entry.id);
  const content = await readInCore(ctx, entry.id);
  return subst === undefined ? content : subst.expandFile(content);
};

const isInside = (path: string, directory: string): boolean => path.startsWith(`${directory}/`);

const isOutside = (path: string, directory: ArchiveEntry | undefined): boolean =>
  directory !== undefined && !isInside(path, directory.path);

/**
 * Held-back directories always form one ancestor chain, deepest last, so the
 * trim stops at the first one still holding `path`.
 */
const keepAncestorsOf = (queued: ArchiveEntry[], path: string): void => {
  while (isOutside(path, queued.at(-1))) queued.pop();
};

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
  subst: SubstExpander | undefined,
): Promise<(entry: WalkTreeEntry) => Promise<ReadonlyArray<ArchiveEntry>>> => {
  const isSet = await createAttributeCheck(ctx, tree);
  const isExportIgnored = (key: string) => isSet(key, EXPORT_IGNORE);
  let queued: ArchiveEntry[] = [];
  let ignoredDirectory: string | undefined;
  return async (entry) => {
    const { path, id, mode } = entry;
    if (ignoredDirectory !== undefined && isInside(path, ignoredDirectory)) return [];
    keepAncestorsOf(queued, path);
    if (mode === FILE_MODE.DIRECTORY) {
      if (await isExportIgnored(`${path}/`)) ignoredDirectory = path;
      else queued.push({ path, mode, oid: id });
      return [];
    }
    const flushed = queued;
    queued = [];
    if (await isExportIgnored(attributeKey(path, mode))) return flushed;
    return [...flushed, await archiveLeaf(ctx, entry, isSet, subst)];
  };
};

/** A non-directory entry, not export-ignored, as archived. */
const archiveLeaf = async (
  ctx: Context,
  entry: WalkTreeEntry,
  isSet: AttributeCheck,
  subst: SubstExpander | undefined,
): Promise<ArchiveEntry> => {
  const { path, id, mode } = entry;
  if (mode === FILE_MODE.GITLINK) return { path, mode, oid: id };
  const content = await readEntryContent(ctx, entry, isSet, subst);
  return { path, mode, oid: id, content };
};
