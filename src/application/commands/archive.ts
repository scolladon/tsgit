import type { ArchiveEntry, ArchiveResult } from '../../domain/archive/index.js';
import { unexpectedObjectType } from '../../domain/objects/error.js';
import { FILE_MODE } from '../../domain/objects/file-mode.js';
import type { ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { peel } from '../primitives/internal/peel.js';
import { readBlob } from '../primitives/read-blob.js';
import { readObject } from '../primitives/read-object.js';
import { walkTree } from '../primitives/walk-tree.js';
import { assertRepository } from './internal/repo-state.js';
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
  await assertRepository(ctx);
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

/**
 * Lazy async generator over all tree entries in pre-order (dir before contents).
 * git archive imposes no entry or depth cap — pass effectively-unbounded limits
 * so walkTree's diff-oriented defaults never abort a large tree.
 * Blob content is hydrated per-entry as the caller iterates; no upfront
 * materialisation of the full tree.
 */
async function* buildEntryStream(ctx: Context, tree: ObjectId): AsyncIterable<ArchiveEntry> {
  for await (const entry of walkTree(ctx, tree, {
    maxEntries: Number.MAX_SAFE_INTEGER,
    maxDepth: Number.MAX_SAFE_INTEGER,
  })) {
    const { path, id, mode } = entry;
    if (mode === FILE_MODE.DIRECTORY || mode === FILE_MODE.GITLINK) {
      yield { path, mode, oid: id };
    } else {
      const blob = await readBlob(ctx, id);
      yield { path, mode, oid: id, content: blob.content };
    }
  }
}
