import { type SquashedCommit, squashMessage } from '../../../domain/merge/squash-message.js';
import type { Commit, ObjectId } from '../../../domain/objects/index.js';
import { parseCommitView } from '../../../domain/pretty/commit-view.js';
import type { Context } from '../../../ports/context.js';
import { abbreviateObjectId } from '../../primitives/abbreviate-object-id.js';
import { readRawObject } from '../../primitives/read-object.js';
import { walkCommitsByDate } from '../../primitives/walk-commits-by-date.js';

/** The raw `author` header value: git reads its date as `split_ident_line` does, not as parsed. */
const rawAuthor = async (ctx: Context, id: ObjectId): Promise<Uint8Array | undefined> =>
  parseCommitView((await readRawObject(ctx, id)).content).author;

/** A commit as `squash_message` prints it: a merge's parents abbreviated. */
const squashed = async (ctx: Context, commit: Commit): Promise<SquashedCommit> => {
  const { parents, message } = commit.data;
  const merge = parents.length > 1;
  const mergeParents = merge
    ? await Promise.all(parents.map((parent) => abbreviateObjectId(ctx, parent)))
    : [];
  return { id: commit.id, mergeParents, author: await rawAuthor(ctx, commit.id), message };
};

/** git's `squash_message`: every commit the heads bring in over `head`, newest first. */
export const buildSquashMessage = async (
  ctx: Context,
  head: ObjectId,
  heads: ReadonlyArray<ObjectId>,
): Promise<string> => {
  const commits: SquashedCommit[] = [];
  for await (const commit of walkCommitsByDate(ctx, { from: heads, until: [head] })) {
    commits.push(await squashed(ctx, commit));
  }
  return squashMessage(commits);
};
