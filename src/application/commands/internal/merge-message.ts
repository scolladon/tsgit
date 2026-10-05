/**
 * git's `fmt_merge_msg` as `merge` and `pull` run it: the title over every
 * head merged, then each annotated tag's message. `merge` describes the head
 * it was given as `merge_name` does; `pull` hands over FETCH_HEAD's lines.
 */
import { configMissingValue } from '../../../domain/commands/error.js';
import { mergeTitle } from '../../../domain/merge/merge-title.js';
import type { ObjectId } from '../../../domain/objects/index.js';
import { compileGlob } from '../../../domain/pathspec/compile-glob.js';
import type { Context } from '../../../ports/context.js';
import { findEntries, type LocatedConfigEntry } from '../../primitives/config-read.js';
import { readObject } from '../../primitives/read-object.js';
import { dwimRefWarning } from './revision-name.js';

/** One head merged, described as a FETCH_HEAD line describes it. */
export interface MergeHead {
  readonly id: ObjectId;
  readonly description: string;
}

/** git's built-in `merge.suppressDest` list, used until the key is configured. */
const DEFAULT_SUPPRESSED = ['main', 'master'] as const;
const LOCAL_SOURCE = ' of .';
const REF_KINDS: ReadonlyArray<readonly [prefix: string, kind: string]> = [
  ['refs/heads/', 'branch'],
  ['refs/tags/', 'tag'],
  ['refs/remotes/', 'remote-tracking branch'],
];

/** git's `merge.suppressDest` values: a valueless entry dies, an empty one clears the list. */
const suppressedPatterns = (entries: ReadonlyArray<LocatedConfigEntry>): ReadonlyArray<string> => {
  const values = entries.map((entry) => {
    if (entry.value === null) throw configMissingValue(entry.key, entry.source, entry.line);
    return entry.value;
  });
  return values.slice(values.lastIndexOf('') + 1);
};

const readSuppressedPatterns = async (ctx: Context): Promise<ReadonlyArray<string>> => {
  const entries = await findEntries(ctx, 'merge', 'suppressDest');
  return entries.length === 0 ? DEFAULT_SUPPRESSED : suppressedPatterns(entries);
};

/** git reads `merge.suppressDest` with its other merge settings, before merging. */
export const assertMergeMessageConfig = async (ctx: Context): Promise<void> => {
  await readSuppressedPatterns(ctx);
};

/** The branch the title merges into, or `undefined` when a pattern suppresses it. */
const destination = async (ctx: Context, branch: string): Promise<string | undefined> => {
  const patterns = await readSuppressedPatterns(ctx);
  const suppressed = patterns.some((pattern) =>
    compileGlob(pattern, { anchored: true }).test(branch),
  );
  return suppressed ? undefined : branch;
};

/** git's `fmt_merge_msg_sigs` for the one head merged: an annotated tag's message
 *  follows the title (the commit's cleanup completes and trims it). */
const tagBlock = async (ctx: Context, head: MergeHead): Promise<string> => {
  const object = await readObject(ctx, head.id);
  return object.type === 'tag' ? `\n${object.data.message}` : '';
};

/** git's `fmt_merge_msg` with a title: the message a merge of `head` into `branch` records. */
export const formatMergeMessage = async (
  ctx: Context,
  head: MergeHead,
  branch: string,
): Promise<string> => {
  const title = mergeTitle([head.description], await destination(ctx, branch));
  return `${title}\n${await tagBlock(ctx, head)}`;
};

/** The kind `merge_name` labels a ref with, when it is one it labels. */
const refKind = (ref: string): string | undefined =>
  REF_KINDS.find(([prefix]) => ref.startsWith(prefix))?.[1];

/**
 * git's `merge_name`: a name that is a branch, tag or remote-tracking ref is
 * described as one of `.`, with the ref's own (unpeeled) id; any other name
 * for a tag object as a tag; anything else as the commit it resolved to.
 */
export const describeMergeHead = async (
  ctx: Context,
  name: string,
  commit: ObjectId,
): Promise<MergeHead> => {
  const found = await dwimRefWarning(ctx, name);
  const kind = found === undefined ? undefined : refKind(found.ref);
  if (found !== undefined && kind !== undefined) {
    return { id: found.id, description: `${kind} '${name}'${LOCAL_SOURCE}` };
  }
  // Only an annotated tag peels to a different commit, so a differing id is a tag.
  if (found !== undefined && found.id !== commit) {
    return { id: found.id, description: `tag '${name}'` };
  }
  return { id: commit, description: `commit '${name}'` };
};
