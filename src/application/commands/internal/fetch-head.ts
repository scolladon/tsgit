/**
 * `.git/FETCH_HEAD`, as git's `store_updated_refs` writes it: one line per
 * fetched remote ref — `<oid> TAB <marker> TAB <description><url>` — the refs
 * for merging first, then the rest marked `not-for-merge`. `pull` reads the
 * merge lines back to know what to integrate.
 */
import { errorDataCode } from '../../../domain/error-data-code.js';
import type { ObjectId } from '../../../domain/objects/index.js';
import { ObjectId as ObjectIdFactory } from '../../../domain/objects/index.js';
import { FETCH_HEAD } from '../../../domain/refs/state-files.js';
import type { Context } from '../../../ports/context.js';
import { peelRefToCommit } from '../../primitives/internal/peel-ref-to-commit.js';
import type { FetchHeadStatus, MappedRef } from './fetch-ref-map.js';
import { anonymizeRemoteUrl } from './remote-url.js';

export interface FetchHeadEntry {
  /** The remote ref's name, as advertised. */
  readonly name: string;
  readonly id: ObjectId;
  readonly status: FetchHeadStatus;
}

export interface FetchHeadLine {
  readonly id: ObjectId;
  readonly forMerge: boolean;
  /** git's note and url, e.g. `branch 'main' of ../peer`. */
  readonly description: string;
}

const NOT_FOR_MERGE = 'not-for-merge';
const GIT_SUFFIX = '.git';
/** git keeps a `.git` suffix unless more than four characters precede its last one. */
const GIT_SUFFIX_MIN_LAST_INDEX = 4;
const TAB = '\t';
const KINDS: ReadonlyArray<readonly [prefix: string, kind: string]> = [
  ['refs/heads/', 'branch '],
  ['refs/tags/', 'tag '],
  ['refs/remotes/', 'remote-tracking branch '],
];

const fetchHeadPath = (ctx: Context): string => `${ctx.layout.gitDir}/${FETCH_HEAD}`;

/** git's `display_state_init`: the anonymized url less its trailing slashes and `.git`. */
export const fetchHeadUrl = (url: string): string => {
  const anonymized = anonymizeRemoteUrl(url);
  let end = anonymized.length;
  while (end > 0 && anonymized[end - 1] === '/') end -= 1;
  const trimmed = anonymized.slice(0, end);
  const keepsSuffix = end - 1 <= GIT_SUFFIX_MIN_LAST_INDEX || !trimmed.endsWith(GIT_SUFFIX);
  return keepsSuffix ? trimmed : trimmed.slice(0, -GIT_SUFFIX.length);
};

const note = (name: string): string => {
  if (name === 'HEAD') return '';
  for (const [prefix, kind] of KINDS) {
    if (name.startsWith(prefix)) return `${kind}'${name.slice(prefix.length)}' of `;
  }
  return `'${name}' of `;
};

const line = (entry: FetchHeadEntry, url: string): string => {
  const marker = entry.status === 'merge' ? '' : NOT_FOR_MERGE;
  return `${entry.id}${TAB}${marker}${TAB}${note(entry.name)}${url.replaceAll('\n', '\\n')}\n`;
};

/** The file's content: merge entries before not-for-merge ones, ignored entries left out. */
export const formatFetchHead = (entries: ReadonlyArray<FetchHeadEntry>, url: string): string => {
  const merge = entries.filter((entry) => entry.status === 'merge');
  const rest = entries.filter((entry) => entry.status === 'not-for-merge');
  return [...merge, ...rest].map((entry) => line(entry, url)).join('');
};

/** git's `lookup_commit_reference_gently`: an absent object names no commit either. */
const namesCommit = async (ctx: Context, id: ObjectId): Promise<boolean> => {
  try {
    return (await peelRefToCommit(ctx, id)) !== undefined;
  } catch (error) {
    if (errorDataCode(error) === 'OBJECT_NOT_FOUND') return false;
    throw error;
  }
};

/** The ref map as listed in FETCH_HEAD: a ref for merging that names no commit is not for merging. */
export const fetchHeadEntries = async (
  ctx: Context,
  refMap: ReadonlyArray<MappedRef>,
): Promise<ReadonlyArray<FetchHeadEntry>> => {
  const entries: FetchHeadEntry[] = [];
  for (const { source, status } of refMap) {
    const demoted = status === 'merge' && !(await namesCommit(ctx, source.id));
    entries.push({ name: source.name, id: source.id, status: demoted ? 'not-for-merge' : status });
  }
  return entries;
};

export const writeFetchHead = async (ctx: Context, content: string): Promise<void> => {
  await ctx.fs.writeUtf8(fetchHeadPath(ctx), content);
};

const parseLine = (text: string): FetchHeadLine => {
  const [id = '', marker, ...description] = text.split(TAB);
  return {
    id: ObjectIdFactory.from(id),
    forMerge: marker !== NOT_FOR_MERGE,
    description: description.join(TAB),
  };
};

export const readFetchHead = async (ctx: Context): Promise<ReadonlyArray<FetchHeadLine>> => {
  const path = fetchHeadPath(ctx);
  if (!(await ctx.fs.exists(path))) return [];
  const content = await ctx.fs.readUtf8(path);
  return content
    .split('\n')
    .filter((text) => text !== '')
    .map(parseLine);
};
