/**
 * Reconstruct the byte-faithful `git show` stream from a structured `ShowResult`.
 *
 * `show` returns structured data only — assembling git's display is the caller's
 * job. This module is that assembly, kept in the test tier so the interop suite
 * can still pin byte-parity against real `git show`. It composes the default
 * renderers relocated here with the `renderPatch` domain serializer (which stays
 * in `src` for rebase / patch-id).
 *
 * Merges reconstruct in `-m` (one block per parent) form — git's textual
 * combined diff (`--cc`) was a removed `show` feature, so merges are pinned
 * against `git show -m`, which mirrors the `perParent` structure directly.
 */
import type { ShowResult } from '../../../src/application/commands/show.js';
import { materialisePatchFiles } from '../../../src/application/primitives/materialise-patch-files.js';
import { renderPatch, type TreeDiff } from '../../../src/domain/diff/index.js';
import type { Context } from '../../../src/ports/context.js';
import { renderCommitBlock } from './render-commit.js';
import { renderTagBlock } from './render-tag.js';
import { renderTreeListing } from './render-tree.js';
import { renderShowStream, type ShowStreamNode } from './show-stream.js';

export interface ShowItem {
  readonly result: ShowResult;
  /** The revision string the caller passed (echoed verbatim in a `tree` header). */
  readonly rev: string;
}

const patchTextOf = async (ctx: Context, diff: TreeDiff): Promise<string> =>
  renderPatch(await materialisePatchFiles(ctx, diff.changes, { applyTextconv: true }));

const commitNode = async (
  ctx: Context,
  result: Extract<ShowResult, { kind: 'commit' }>,
): Promise<ShowStreamNode> => {
  const { perParent } = result;
  if (perParent !== undefined) {
    // Map over parents (well-typed `ObjectId`) and pair each with its diff; the
    // two arrays are built together in `show`, so they are index-aligned.
    const blocks = await Promise.all(
      result.commit.parents.map((fromParent, i) =>
        patchTextOf(ctx, perParent[i] as TreeDiff).then((patchText) =>
          renderCommitBlock({ id: result.id, commit: result.commit, fromParent, patchText }),
        ),
      ),
    );
    return { kind: 'commit', id: result.id, text: blocks.join('\n') };
  }
  const patchText = result.patch !== undefined ? await patchTextOf(ctx, result.patch) : '';
  return {
    kind: 'commit',
    id: result.id,
    text: renderCommitBlock({
      id: result.id,
      commit: result.commit,
      ...(patchText !== '' ? { patchText } : {}),
    }),
  };
};

const toNode = async (ctx: Context, result: ShowResult, rev: string): Promise<ShowStreamNode> => {
  switch (result.kind) {
    case 'blob':
      return { kind: 'blob', content: result.content };
    case 'tree':
      return { kind: 'tree', text: renderTreeListing(rev, result.entries) };
    case 'commit':
      return commitNode(ctx, result);
    case 'tag':
      return {
        kind: 'tag',
        text: renderTagBlock(result.tag),
        target: await toNode(ctx, result.target, rev),
      };
  }
};

export const reconstructShow = async (
  ctx: Context,
  items: ReadonlyArray<ShowItem>,
): Promise<Uint8Array> => {
  const nodes: ShowStreamNode[] = [];
  for (const { result, rev } of items) nodes.push(await toNode(ctx, result, rev));
  return renderShowStream(nodes);
};
