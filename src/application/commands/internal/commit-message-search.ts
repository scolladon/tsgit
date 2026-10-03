import { BinaryHeap } from '../../../domain/commit/binary-heap.js';
import { precedesByArrival } from '../../../domain/commit/priority-queue.js';
import { errorDataCode } from '../../../domain/error-data-code.js';
import { type Commit, commitBodyBytes } from '../../../domain/objects/commit.js';
import { decodePreservingBom } from '../../../domain/objects/encoding.js';
import type { GitObject, ObjectId, RefName } from '../../../domain/objects/index.js';
import { compileExtendedRegex } from '../../../domain/regex/extended-regex.js';
import type { Context } from '../../../ports/context.js';
import { enumerateRefs } from '../../primitives/enumerate-refs.js';
import {
  type CommitMeta,
  commitMetaOf,
  readCommitMeta,
} from '../../primitives/internal/read-commit-meta.js';
import { readObject, readRawObject } from '../../primitives/read-object.js';
import { resolveRefForReading } from '../../primitives/resolve-ref.js';

/**
 * git's `get_oid_oneline`: walking back from `seeds` youngest first — by
 * commit date, an equal date in the order queued — the first commit whose
 * message matches `search`, a POSIX extended regex. `!-` negates it and `!!`
 * spells a leading `!`; any other leading `!`, or a pattern regcomp refuses,
 * matches nothing.
 */
export const searchCommitMessages = async (
  ctx: Context,
  seeds: ReadonlyArray<Commit>,
  search: string,
): Promise<ObjectId | undefined> => {
  const test = parseMessageTest(search);
  if (test === undefined) return undefined;
  const walk: Walk = {
    heap: new BinaryHeap<Queued>(precedesByArrival),
    seen: new Set(),
    arrivals: 0,
  };
  for (const seed of seeds) enqueue(walk, seed.id, await commitMetaOf(ctx, seed));
  for (let top = walk.heap.pop(); top !== undefined; top = walk.heap.pop()) {
    await enqueueParents(ctx, walk, top.parents);
    if (await messageMatches(ctx, top.id, test)) return top.id;
  }
  return undefined;
};

/** git's `:/<regex>`: the search from every ref under `refs/`, then HEAD. */
export const searchRefMessages = async (
  ctx: Context,
  search: string,
): Promise<ObjectId | undefined> => searchCommitMessages(ctx, await refTipCommits(ctx), search);

const REFS_PREFIX = 'refs/';
const HEAD = 'HEAD';

/** git's seed list: each ref in name order, then HEAD, put at the list's head — HEAD ends first. */
const refTipCommits = async (ctx: Context): Promise<ReadonlyArray<Commit>> => {
  const names = (await enumerateRefs(ctx)).filter((name) => name.startsWith(REFS_PREFIX));
  const tips: Commit[] = [];
  for (const name of [...names, HEAD] as const) {
    const tip = await refTipCommit(ctx, name);
    if (tip !== undefined) tips.unshift(tip);
  }
  return tips;
};

/**
 * git's `handle_one_ref`: the commit a ref names through its tags. An object
 * that does not read is skipped; a tag of one is reported under the ref's name.
 */
const refTipCommit = async (ctx: Context, name: RefName | 'HEAD'): Promise<Commit | undefined> => {
  const id = await resolveRefForReading(ctx, name);
  if (id === undefined) return undefined;
  let object = await readPresent(ctx, id);
  while (object?.type === 'tag') {
    object = await readPresent(ctx, object.data.object);
    if (object === undefined)
      ctx.logger?.error?.(`missing object referenced by '${name}'`, { name });
  }
  return object?.type === 'commit' ? object : undefined;
};

const readPresent = async (ctx: Context, id: ObjectId): Promise<GitObject | undefined> => {
  try {
    return await readObject(ctx, id);
  } catch (error) {
    if (errorDataCode(error) === 'OBJECT_NOT_FOUND') return undefined;
    throw error;
  }
};

interface MessageTest {
  readonly pattern: RegExp;
  readonly negated: boolean;
}

interface Queued {
  readonly id: ObjectId;
  readonly date: number;
  readonly parents: ReadonlyArray<ObjectId>;
  /** git's `prio_queue` insertion counter: the tie-break between equal dates. */
  readonly arrival: number;
}

/** The queue, the commits ever queued (git's `ONELINE_SEEN`) and the arrival counter. */
interface Walk {
  readonly heap: BinaryHeap<Queued>;
  readonly seen: Set<ObjectId>;
  arrivals: number;
}

const BANG = '!';
const NEGATION = '!-';
const ESCAPED_BANG = '!!';
const NUL = 0;

const parseMessageTest = (search: string): MessageTest | undefined => {
  const spelt = splitNegation(search);
  if (spelt === undefined) return undefined;
  const pattern = compileExtendedRegex(spelt.source);
  return pattern === undefined ? undefined : { pattern, negated: spelt.negated };
};

const splitNegation = (
  search: string,
): { readonly source: string; readonly negated: boolean } | undefined => {
  if (!search.startsWith(BANG)) return { source: search, negated: false };
  if (search.startsWith(NEGATION)) return { source: search.slice(NEGATION.length), negated: true };
  if (search.startsWith(ESCAPED_BANG)) return { source: search.slice(BANG.length), negated: false };
  return undefined;
};

const enqueue = (walk: Walk, id: ObjectId, meta: CommitMeta): void => {
  walk.seen.add(id);
  walk.heap.push({ id, date: meta.committerDate, parents: meta.parents, arrival: walk.arrivals });
  walk.arrivals += 1;
};

/** git's `pop_most_recent_commit`: each parent not yet queued that parses joins the queue. */
const enqueueParents = async (
  ctx: Context,
  walk: Walk,
  parents: ReadonlyArray<ObjectId>,
): Promise<void> => {
  for (const parent of parents) {
    if (walk.seen.has(parent)) continue;
    const meta = await parseParent(ctx, parent);
    if (meta !== undefined) enqueue(walk, parent, meta);
  }
};

/** git's `repo_parse_commit`: a parent that does not parse is reported and skipped. */
const parseParent = async (ctx: Context, id: ObjectId): Promise<CommitMeta | undefined> => {
  try {
    const meta = await readCommitMeta(ctx, id);
    if (meta === undefined) ctx.logger?.error?.(`Object ${id} not a commit`, { id });
    return meta;
  } catch (error) {
    if (errorDataCode(error) !== 'OBJECT_NOT_FOUND') throw error;
    ctx.logger?.error?.(`Could not read ${id}`, { id });
    return undefined;
  }
};

/** A commit with no message matches only a negated pattern. */
const messageMatches = async (ctx: Context, id: ObjectId, test: MessageTest): Promise<boolean> => {
  const content = await readCommitContent(ctx, id);
  if (content === undefined) return false;
  const body = commitBodyBytes(content);
  const matched = body !== undefined && test.pattern.test(asCString(body));
  return matched !== test.negated;
};

/** git's `parse_object` before the buffer is read: a commit whose object is gone is passed over. */
const readCommitContent = async (ctx: Context, id: ObjectId): Promise<Uint8Array | undefined> => {
  try {
    return (await readRawObject(ctx, id)).content;
  } catch (error) {
    if (errorDataCode(error) === 'OBJECT_NOT_FOUND') return undefined;
    throw error;
  }
};

/** regexec reads the message as a C string: up to its first NUL. */
const asCString = (bytes: Uint8Array): string => {
  const nul = bytes.indexOf(NUL);
  return decodePreservingBom(nul === -1 ? bytes : bytes.subarray(0, nul));
};
