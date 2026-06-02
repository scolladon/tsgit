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
  type DateFormatter,
  formatDate,
  type PrettyCommitContext,
  renderCommitBlock,
  renderPrettyCommit,
  renderShowStream,
  renderTagBlock,
  renderTreeListing,
  type ShowStreamNode,
} from '../../domain/show/index.js';
import type { Context } from '../../ports/context.js';
import { diffTrees } from '../primitives/diff-trees.js';
import { materialisePatchFiles } from '../primitives/materialise-patch-files.js';
import { readObject } from '../primitives/read-object.js';
import type { PatchResult } from './diff.js';
import { treeOf } from './internal/history-rewrite.js';
import { assertRepository } from './internal/repo-state.js';
import { buildDecorationMap, type CommitDecoration } from './internal/show-decoration.js';
import { parseShowOptions, type ResolvedShowPlan } from './internal/show-options.js';
import { revParse } from './rev-parse.js';

/** Per-call rendering environment threaded to the object builders. */
interface RenderEnv {
  readonly plan: ResolvedShowPlan;
  readonly formatDate: DateFormatter;
  readonly now: number;
  readonly decorations: ReadonlyMap<ObjectId, CommitDecoration> | undefined;
}

export type ShowInput = string | ReadonlyArray<string>;

/** How a merge commit's diff is rendered. Default `dense` (git's `show`). */
export type MergeDiffMode = 'none' | 'separate' | 'combined' | 'dense';

/** `--stat[=<width>,<name-width>,<count>]` overrides. */
export interface ShowStatOptions {
  readonly width?: number;
  readonly nameWidth?: number;
  readonly count?: number;
}

export interface ShowOptions {
  /** Context lines bracketing each hunk in commit patches. Default 3. */
  readonly contextLines?: number;
  /** `-s` / `--no-patch`: suppress all diff output (patch / stat / combined). */
  readonly noPatch?: boolean;
  /** `--pretty` / `--format`: named format or `format:`/`tformat:`. Default `medium`. */
  readonly format?: string;
  /** `--date=<mode>`. Default `default`. */
  readonly date?: string;
  /** `--stat`: `true` for default width, or width overrides. */
  readonly stat?: boolean | ShowStatOptions;
  /** `--numstat`. */
  readonly numstat?: boolean;
  /** `-m` / `-c` / `--cc`. Default `dense` (git's merge default). */
  readonly mergeDiff?: MergeDiffMode;
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
  const plan = parseShowOptions(opts);
  // `now` is read once so a `--date=relative`/`human` rendering is consistent
  // across every object in the stream (mirrors revParse's single clock read).
  const now = Math.floor(Date.now() / 1000);
  const formatDateFor: DateFormatter = (identity) =>
    formatDate(plan.dateMode, identity.timestamp, identity.timezoneOffset, now);
  // Decoration is only observable through the custom `%d`/`%D` placeholders, so
  // the ref scan is skipped for the built-in formats.
  const decorations = plan.format.kind === 'custom' ? await buildDecorationMap(ctx) : undefined;
  const env: RenderEnv = { plan, formatDate: formatDateFor, now, decorations };
  const revs = typeof input === 'string' ? [input] : input;
  const objects: ShowResult[] = [];
  for (const rev of revs) {
    const id = await revParse(ctx, rev);
    objects.push(await buildResult(ctx, rev, await readObject(ctx, id), env));
  }
  return { objects, bytes: renderShowStream(objects.map(toStreamNode)) };
}

async function buildResult(
  ctx: Context,
  rev: string,
  obj: GitObject,
  env: RenderEnv,
): Promise<ShowResult> {
  switch (obj.type) {
    case 'blob':
      return { kind: 'blob', id: obj.id, content: obj.content };
    case 'tree':
      return buildTree(rev, obj);
    case 'commit':
      return buildCommit(ctx, obj, env);
    case 'tag':
      return buildTag(ctx, rev, obj, env);
  }
}

function buildTree(rev: string, obj: Tree): ShowTreeResult {
  const entries = obj.entries.map((e) => ({ name: e.name, mode: e.mode, id: e.id }));
  return { kind: 'tree', id: obj.id, entries, text: renderTreeListing(rev, entries) };
}

async function buildCommit(ctx: Context, obj: Commit, env: RenderEnv): Promise<ShowCommitResult> {
  // Merge commits keep the medium path here; their combined diff wires in later.
  if (obj.data.parents.length >= 2) {
    const text = renderCommitBlock({
      id: obj.id,
      commit: obj.data,
      noPatch: env.plan.noPatch,
      formatDate: env.formatDate,
    });
    return { kind: 'commit', id: obj.id, commit: obj.data, text };
  }
  // `-s` suppresses the diff; otherwise compute the patch and frame it per format.
  const patch = env.plan.noPatch ? undefined : await commitPatch(ctx, obj.data, env.plan);
  const decoration = env.decorations?.get(obj.id);
  const prettyCtx: PrettyCommitContext = {
    id: obj.id,
    commit: obj.data,
    formatDate: env.formatDate,
    dateMode: env.plan.dateMode,
    now: env.now,
    refs: decoration?.refs ?? [],
    ...(decoration?.headBranch !== undefined ? { headBranch: decoration.headBranch } : {}),
    ...(decoration?.detachedHead === true ? { detachedHead: true } : {}),
  };
  const text = renderPrettyCommit(env.plan.format, prettyCtx, {
    noPatch: env.plan.noPatch,
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
  env: RenderEnv,
): Promise<ShowTagResult> {
  const target = await buildResult(ctx, rev, await readObject(ctx, obj.data.object), env);
  return {
    kind: 'tag',
    id: obj.id,
    tag: obj.data,
    target,
    text: renderTagBlock(obj.data, env.formatDate),
  };
}

async function commitPatch(
  ctx: Context,
  commit: CommitData,
  plan: ResolvedShowPlan,
): Promise<PatchResult> {
  // `git show` diffs recursively against the first parent (root commits against
  // the empty tree) with rename detection on by default. The recursive
  // `diffTrees` flattens both sides so sub-directories surface as per-file
  // changes.
  const parent = commit.parents[0];
  const oldTree = parent !== undefined ? await treeOf(ctx, parent) : undefined;
  const diff: TreeDiff = await diffTrees(ctx, oldTree, commit.tree, {
    recursive: true,
    detectRenames: true,
  });
  const files = await materialisePatchFiles(ctx, diff.changes);
  const text = renderPatch(
    files,
    plan.contextLines !== undefined ? { contextLines: plan.contextLines } : {},
  );
  return { format: 'patch', text, diff };
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
