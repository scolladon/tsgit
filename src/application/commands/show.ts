/**
 * Tier-1 `show` command — faithful `git show` for commit / tag / tree / blob
 * objects. Resolves each revision (full rev-parse grammar, no tag auto-peel),
 * reads the object, and builds a structured `ShowResult` carrying both the
 * parsed data and the rendered text; `bytes` is the byte-faithful stream
 * `git show <input…>` prints (ADRs 240–242).
 */
import { renderPatch, type TreeDiff } from '../../domain/diff/index.js';
import type {
  Commit,
  CommitData,
  FileMode,
  GitObject,
  ObjectId,
  Tag,
  TagData,
  Tree,
} from '../../domain/objects/index.js';
import {
  renderCommitBlock,
  renderShowStream,
  renderTagBlock,
  renderTreeListing,
  type ShowStreamNode,
} from '../../domain/show/index.js';
import type { Context } from '../../ports/context.js';
import { diffTrees } from '../primitives/diff-trees.js';
import { flattenTree } from '../primitives/flatten-tree.js';
import { materialisePatchFiles } from '../primitives/materialise-patch-files.js';
import { readObject } from '../primitives/read-object.js';
import type { PatchResult } from './diff.js';
import { treeOf } from './internal/history-rewrite.js';
import { assertRepository } from './internal/repo-state.js';
import { revParse } from './rev-parse.js';

export type ShowInput = string | ReadonlyArray<string>;

export interface ShowOptions {
  /** Context lines bracketing each hunk in commit patches. Default 3. */
  readonly contextLines?: number;
}

export interface ShowTreeEntry {
  readonly name: string;
  readonly mode: FileMode;
  readonly id: ObjectId;
}

export interface ShowCommitResult {
  readonly kind: 'commit';
  readonly id: ObjectId;
  readonly commit: CommitData;
  readonly patch?: PatchResult;
  readonly text: string;
}

export interface ShowTagResult {
  readonly kind: 'tag';
  readonly id: ObjectId;
  readonly tag: TagData;
  readonly target: ShowResult;
  readonly text: string;
}

export interface ShowTreeResult {
  readonly kind: 'tree';
  readonly id: ObjectId;
  readonly entries: ReadonlyArray<ShowTreeEntry>;
  readonly text: string;
}

export interface ShowBlobResult {
  readonly kind: 'blob';
  readonly id: ObjectId;
  readonly content: Uint8Array;
}

export type ShowResult = ShowCommitResult | ShowTagResult | ShowTreeResult | ShowBlobResult;

export interface ShowOutput {
  /** One result per input rev, in input order. */
  readonly objects: ReadonlyArray<ShowResult>;
  /** Byte-faithful `git show <input…>` stream. */
  readonly bytes: Uint8Array;
}

const DEFAULT_REV = 'HEAD';

export async function show(
  ctx: Context,
  input: ShowInput = DEFAULT_REV,
  opts: ShowOptions = {},
): Promise<ShowOutput> {
  await assertRepository(ctx);
  const revs = typeof input === 'string' ? [input] : input;
  const objects: ShowResult[] = [];
  for (const rev of revs) {
    const id = await revParse(ctx, rev);
    objects.push(await buildResult(ctx, rev, await readObject(ctx, id), opts));
  }
  return { objects, bytes: renderShowStream(objects.map(toStreamNode)) };
}

async function buildResult(
  ctx: Context,
  rev: string,
  obj: GitObject,
  opts: ShowOptions,
): Promise<ShowResult> {
  switch (obj.type) {
    case 'blob':
      return { kind: 'blob', id: obj.id, content: obj.content };
    case 'tree':
      return buildTree(rev, obj);
    case 'commit':
      return buildCommit(ctx, obj, opts);
    case 'tag':
      return buildTag(ctx, rev, obj, opts);
  }
}

function buildTree(rev: string, obj: Tree): ShowTreeResult {
  const entries = obj.entries.map((e) => ({ name: e.name, mode: e.mode, id: e.id }));
  return { kind: 'tree', id: obj.id, entries, text: renderTreeListing(rev, entries) };
}

async function buildCommit(
  ctx: Context,
  obj: Commit,
  opts: ShowOptions,
): Promise<ShowCommitResult> {
  const patch = obj.data.parents.length < 2 ? await commitPatch(ctx, obj.data, opts) : undefined;
  const text = renderCommitBlock({
    id: obj.id,
    commit: obj.data,
    ...(patch !== undefined ? { patchText: patch.text } : {}),
  });
  return {
    kind: 'commit',
    id: obj.id,
    commit: obj.data,
    ...(patch !== undefined ? { patch } : {}),
    text,
  };
}

async function buildTag(
  ctx: Context,
  rev: string,
  obj: Tag,
  opts: ShowOptions,
): Promise<ShowTagResult> {
  const target = await buildResult(ctx, rev, await readObject(ctx, obj.data.object), opts);
  return { kind: 'tag', id: obj.id, tag: obj.data, target, text: renderTagBlock(obj.data) };
}

async function commitPatch(
  ctx: Context,
  commit: CommitData,
  opts: ShowOptions,
): Promise<PatchResult> {
  const parent = commit.parents[0];
  // `git show` diffs recursively; the single-level `diffTrees` would surface a
  // sub-directory as one tree-add. Flatten both trees to full-path blob entries
  // first so the patch is per-file (the synthetic trees carry slash-bearing
  // names that are never serialised).
  const oldTree =
    parent !== undefined ? await flattenedTree(ctx, await treeOf(ctx, parent)) : undefined;
  const newTree = await flattenedTree(ctx, commit.tree);
  const diff: TreeDiff = await diffTrees(ctx, oldTree, newTree, { detectRenames: true });
  const files = await materialisePatchFiles(ctx, diff.changes);
  const text = renderPatch(
    files,
    opts.contextLines !== undefined ? { contextLines: opts.contextLines } : {},
  );
  return { format: 'patch', text, diff };
}

async function flattenedTree(ctx: Context, treeId: ObjectId): Promise<Tree> {
  const flat = await flattenTree(ctx, treeId);
  const entries = Array.from(flat.entries, ([name, entry]) => ({
    name,
    mode: entry.mode,
    id: entry.id,
  }));
  return { type: 'tree', id: treeId, entries };
}

function toStreamNode(result: ShowResult): ShowStreamNode {
  switch (result.kind) {
    case 'blob':
      return { kind: 'blob', content: result.content };
    case 'tree':
      return { kind: 'tree', text: result.text };
    case 'commit':
      return { kind: 'commit', id: result.id, text: result.text };
    case 'tag':
      return { kind: 'tag', text: result.text, target: toStreamNode(result.target) };
  }
}
