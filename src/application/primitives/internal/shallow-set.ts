/**
 * Per-`Context` `.git/shallow` memo — mirrors `internal/loose-oid-cache.ts`'s
 * `fanoutCache` and `read-commit-graph.ts`'s `graphCache`. Every grafted
 * commit read consults the shallow set, so this module amortises the
 * `.git/shallow` probe to exactly one filesystem call per `Context` lifetime
 * instead of one per commit.
 *
 * `present` and `set` are deliberately two distinct signals, not derived from
 * each other: an existing-but-0-byte `.git/shallow` is a shallow repository
 * (`present: true`) with an empty cut set, the case that decides a presence
 * gate over a content gate for commit-graph consultation (`present`, not
 * `set.size > 0`, is what a *different* caller should test).
 *
 * The promise itself (not its resolved value) is memoised, so concurrent
 * grafted reads racing the first probe share one `readUtf8` call.
 */
import { TsgitError } from '../../../domain/error.js';
import type { ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { commonGitDir, shallowFilePath } from '../path-layout.js';
import { parseShallowFile } from './parse-shallow.js';

interface ShallowState {
  readonly present: boolean;
  readonly set: ReadonlySet<ObjectId>;
}

const EMPTY_SHALLOW_STATE: ShallowState = { present: false, set: new Set() };

const shallowCache = new WeakMap<Context, Promise<ShallowState>>();

function isAbsentShallowFile(error: unknown): boolean {
  return (
    error instanceof TsgitError &&
    (error.data.code === 'FILE_NOT_FOUND' || error.data.code === 'NOT_A_DIRECTORY')
  );
}

async function loadStateUncached(ctx: Context): Promise<ShallowState> {
  let raw: string;
  try {
    raw = await ctx.fs.readUtf8(shallowFilePath(commonGitDir(ctx)));
  } catch (error) {
    if (isAbsentShallowFile(error)) return EMPTY_SHALLOW_STATE;
    throw error;
  }
  return { present: true, set: new Set(parseShallowFile(raw)) };
}

function loadState(ctx: Context): Promise<ShallowState> {
  let cached = shallowCache.get(ctx);
  if (cached === undefined) {
    cached = loadStateUncached(ctx);
    shallowCache.set(ctx, cached);
    // Never memoize a rejection: a transient fs failure (or a malformed file
    // later fixed) must not permanently poison every later read.
    cached.catch(() => shallowCache.delete(ctx));
  }
  return cached;
}

/** The repository's shallow-boundary oids, loaded once per `Context`. */
export const loadShallowSet = async (ctx: Context): Promise<ReadonlySet<ObjectId>> =>
  (await loadState(ctx)).set;

/** Whether `.git/shallow` exists at all — presence, independent of content. */
export const isShallowRepository = async (ctx: Context): Promise<boolean> =>
  (await loadState(ctx)).present;

/** Drop the memo so the next accessor call re-reads `.git/shallow`. */
export const invalidateShallowSet = (ctx: Context): void => {
  shallowCache.delete(ctx);
};
