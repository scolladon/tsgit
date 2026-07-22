/**
 * Compute a commit's **patch-id** — the internal equivalence key `rebase` uses to
 * drop commits already present upstream (cherry-pick equivalents), git's default.
 *
 * The id replicates git's *equivalence semantics* (not its exact hex, which is
 * never persisted or observable — see ADR-231): the commit's introduced diff,
 * rendered by the byte-faithful unified-diff serializer, then canonicalised by
 * dropping the `@@` hunk headers (line numbers ignored) and the `index <a>..<b>`
 * lines (base blob oids — which differ for an equivalent patch applied on a
 * different base), and stripping intra-line whitespace. Two commits introducing
 * the same change to the same path therefore collide regardless of line offset.
 *
 * Binary changes carry no textual hunks, so the diff text alone cannot tell two
 * binary patches apart; their blob oids are folded into the key (mirroring git's
 * binary patch-id path) so distinct binary content yields distinct ids.
 */
import { type DiffChange, isBinary, renderPatch } from '../../domain/diff/index.js';
import type { CommitData } from '../../domain/objects/commit.js';
import { unexpectedObjectType } from '../../domain/objects/error.js';
import type { ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { diffTrees } from './diff-trees.js';
import { materialisePatchFiles } from './materialise-patch-files.js';
import { readObject } from './read-object.js';

const ENCODER = new TextEncoder();
const EMPTY = new Uint8Array();

const readCommitData = async (ctx: Context, id: ObjectId): Promise<CommitData> => {
  const obj = await readObject(ctx, id);
  if (obj.type !== 'commit') throw unexpectedObjectType('commit', obj.type, id);
  return obj.data;
};

/** Drop the line-number `@@` headers and base-oid `index` lines, then strip
 *  whitespace — the bytes that distinguish a change from an equivalent one. */
const canonicalise = (patchText: string): string =>
  patchText
    .split('\n')
    .filter((line) => !line.startsWith('@@ ') && !line.startsWith('index '))
    .map((line) => line.replace(/\s/g, ''))
    .join('');

/** Both blob oids carried by a change, in old→new order (absent side → empty). */
const oidsOf = (change: DiffChange): string => {
  const old = 'oldId' in change ? change.oldId : '';
  const next = 'newId' in change && change.newId !== undefined ? change.newId : '';
  return `${old}${next}`;
};

export const computePatchId = async (ctx: Context, commitId: ObjectId): Promise<string> => {
  const cData = await readCommitData(ctx, commitId);
  const parentId = cData.parents[0];
  const parentTree =
    parentId !== undefined ? (await readCommitData(ctx, parentId)).tree : undefined;
  // git's patch-id is a recursive diff: a commit touching a nested file must
  // surface per-file hunks, not a tree-oid change that patch hydration rejects.
  const diff = await diffTrees(ctx, parentTree, cData.tree, { recursive: true });
  const files = await materialisePatchFiles(ctx, diff.changes);
  // Stryker disable next-line StringLiteral: equivalent — the `a/`/`b/` prefixes are cosmetic: the `diff --git` header renders both `a/<path>` and `b/<path>`, so dropping either prefix leaves the path recoverable from the other, and the patch-id equivalence relation is unchanged.
  const text = renderPatch(files, { contextLines: 3, pathPrefix: { old: 'a/', new: 'b/' } });
  const binaryKey = files
    .filter((f) => isBinary(f.oldContent ?? EMPTY) || isBinary(f.newContent ?? EMPTY))
    .map((f) => oidsOf(f.change))
    // Stryker disable next-line StringLiteral: equivalent — the separator only sits between per-file oid strings, and the canonical text already fixes each file's change type (hence every oidsOf length), so any separator re-splits the concatenation identically and the equivalence relation is unchanged.
    .join('');
  return ctx.hash.hashHex(ENCODER.encode(canonicalise(text) + binaryKey));
};
