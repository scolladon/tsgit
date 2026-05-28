import type { DiffChange, PatchFile, PatchPathPrefix, TreeDiff } from '../../domain/diff/index.js';
import { renderPatch } from '../../domain/diff/index.js';
import type { ObjectId } from '../../domain/objects/index.js';
import { validateRefName } from '../../domain/refs/index.js';
import type { Context } from '../../ports/context.js';
import { diffTrees } from '../primitives/diff-trees.js';
import { readBlob } from '../primitives/read-blob.js';
import { readObject } from '../primitives/read-object.js';
import { resolveRef } from '../primitives/resolve-ref.js';
import { assertRepository } from './internal/repo-state.js';

export type DiffFormat = 'tree' | 'patch';

export interface DiffOptions {
  /** Resolve to a tree. Accepts ref name, oid, or 'HEAD'. */
  readonly from?: string;
  readonly to?: string;
  readonly detectRenames?: boolean;
  /** Output format. Default `'tree'` for backward compatibility. */
  readonly format?: DiffFormat;
  /** Lines of equal context bracketing each hunk. Default `3`. Patch-only. */
  readonly contextLines?: number;
  /** Path prefixes on `diff --git`, `--- a/`, `+++ b/` lines. Default `{ old: 'a/', new: 'b/' }`. */
  readonly pathPrefix?: PatchPathPrefix;
}

export interface PatchResult {
  readonly format: 'patch';
  readonly text: string;
  readonly diff: TreeDiff;
}

export type DiffResult = TreeDiff | PatchResult;

/**
 * Diff two tree-like targets. Returns a structured `TreeDiff` by default;
 * pass `format: 'patch'` for a canonical unified-diff text plus the
 * structured view bundled together.
 */
export function diff(ctx: Context, opts?: DiffOptions & { format?: 'tree' }): Promise<TreeDiff>;
export function diff(ctx: Context, opts: DiffOptions & { format: 'patch' }): Promise<PatchResult>;
export async function diff(ctx: Context, opts: DiffOptions = {}): Promise<DiffResult> {
  await assertRepository(ctx);
  const from = await resolveTreeId(ctx, opts.from ?? 'HEAD');
  const to = opts.to !== undefined ? await resolveTreeId(ctx, opts.to) : undefined;
  const tree = await diffTrees(
    ctx,
    from,
    to,
    opts.detectRenames === true ? { detectRenames: true } : {},
  );
  if (opts.format !== 'patch') return tree;
  const files = await materialisePatchFiles(ctx, tree.changes);
  const text = renderPatch(files, buildPatchOptions(opts));
  return { format: 'patch', text, diff: tree };
}

function buildPatchOptions(opts: DiffOptions): {
  readonly contextLines?: number;
  readonly pathPrefix?: PatchPathPrefix;
} {
  const out: { contextLines?: number; pathPrefix?: PatchPathPrefix } = {};
  if (opts.contextLines !== undefined) out.contextLines = opts.contextLines;
  if (opts.pathPrefix !== undefined) out.pathPrefix = opts.pathPrefix;
  return out;
}

const resolveTreeId = async (ctx: Context, target: string): Promise<ObjectId> => {
  // `validateRefName` is the identity for already-valid names (`'HEAD'`
  // included), so a separate HEAD short-circuit would be redundant.
  const id = /^[0-9a-f]{40}$/.test(target)
    ? (target as ObjectId)
    : await resolveRef(ctx, validateRefName(target));
  const obj = await readObject(ctx, id);
  if (obj.type === 'commit') return obj.data.tree;
  // A non-commit target (tree, blob, tag) is used verbatim; `diffTrees` is the
  // single place that validates the resolved id is tree-shaped.
  return id;
};

async function materialisePatchFiles(
  ctx: Context,
  changes: ReadonlyArray<DiffChange>,
): Promise<ReadonlyArray<PatchFile>> {
  return Promise.all(changes.map((change) => materialiseOne(ctx, change)));
}

async function materialiseOne(ctx: Context, change: DiffChange): Promise<PatchFile> {
  if (change.type === 'add') {
    const blob = await readBlob(ctx, change.newId);
    return { change, newContent: blob.content };
  }
  if (change.type === 'delete') {
    const blob = await readBlob(ctx, change.oldId);
    return { change, oldContent: blob.content };
  }
  if (change.type === 'rename') {
    return { change };
  }
  // modify or type-change — load both sides (skip when ids match to avoid I/O).
  if (change.oldId === change.newId) {
    const blob = await readBlob(ctx, change.oldId);
    return { change, oldContent: blob.content, newContent: blob.content };
  }
  const [oldBlob, newBlob] = await Promise.all([
    readBlob(ctx, change.oldId),
    readBlob(ctx, change.newId),
  ]);
  return { change, oldContent: oldBlob.content, newContent: newBlob.content };
}
