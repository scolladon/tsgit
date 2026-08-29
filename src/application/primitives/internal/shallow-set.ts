/**
 * Per-session `.git/shallow` memo — mirrors `internal/loose-oid-cache.ts`'s
 * `fanoutCache` and `read-commit-graph.ts`'s `graphCache`. Every grafted
 * commit read consults the shallow set, so this module amortises the
 * `.git/shallow` probe to exactly one filesystem call per session lifetime
 * instead of one per commit — shared across every Context derived from the
 * same repository-open, since `.git/shallow` lives under `commonGitDir(ctx)`.
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
import type { ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { commonGitDir, shallowFilePath } from '../path-layout.js';
import { errorDataCode } from './error-data-code.js';
import { parseShallowFile } from './parse-shallow.js';

interface ShallowState {
  readonly present: boolean;
  readonly set: ReadonlySet<ObjectId>;
}

const EMPTY_SHALLOW_STATE: ShallowState = { present: false, set: new Set() };

const shallowCache = new WeakMap<Context['session'], Promise<ShallowState>>();

/**
 * Shared absence predicate for `.git/shallow` — used by this memo AND by
 * `shallow-file.ts`'s `readShallow`, so the two readers of the file agree
 * on what "absent" means. `NOT_A_DIRECTORY` counts as absent for the same
 * reason as `internal/loose-oid-cache.ts`'s fanout probe: a `Context`
 * whose git dir does not exist at all is routine in unit tests and must
 * not make every read throw.
 */
export function isAbsentShallowFile(error: unknown): boolean {
  const code = errorDataCode(error);
  return code === 'FILE_NOT_FOUND' || code === 'NOT_A_DIRECTORY';
}

async function loadStateUncached(ctx: Context): Promise<ShallowState> {
  // A single throwing readUtf8, deliberately NOT the `exists`-gates-the-read
  // rule read-commit-graph.ts follows: here presence AND content are both
  // needed, so one call covers either branch — an exists+read pair would
  // spend two syscalls on every shallow repository.
  let raw: string;
  try {
    raw = await ctx.fs.readUtf8(shallowFilePath(commonGitDir(ctx)));
  } catch (error) {
    if (isAbsentShallowFile(error)) return EMPTY_SHALLOW_STATE;
    throw error;
  }
  return { present: true, set: new Set(parseShallowFile(raw, ctx.hashConfig.hexLength)) };
}

function loadState(ctx: Context): Promise<ShallowState> {
  const existing = shallowCache.get(ctx.session);
  if (existing !== undefined) return existing;
  const created = loadStateUncached(ctx);
  shallowCache.set(ctx.session, created);
  // Never memoize a rejection: a transient fs failure (or a malformed file
  // later fixed) must not permanently poison every later read. Only evict
  // our own entry — an invalidate-then-reload interleaving may have stored
  // a fresh promise this rejection must not tear down.
  created.catch(() => {
    if (shallowCache.get(ctx.session) === created) shallowCache.delete(ctx.session);
  });
  return created;
}

/** The repository's shallow-boundary oids, loaded once per `Context`. */
export const loadShallowSet = async (ctx: Context): Promise<ReadonlySet<ObjectId>> =>
  (await loadState(ctx)).set;

/**
 * The shallow set a walk should mask with: the caller's explicit override
 * (including an empty `Set`, the no-masking escape hatch) or the repository's
 * own `.git/shallow` set. One definition shared by both walk cores, so the
 * override semantics cannot drift between them.
 */
export const resolveShallow = async (
  ctx: Context,
  override: ReadonlySet<ObjectId> | undefined,
): Promise<ReadonlySet<ObjectId>> => override ?? loadShallowSet(ctx);

/** Whether `.git/shallow` exists at all — presence, independent of content. */
export const isShallowRepository = async (ctx: Context): Promise<boolean> =>
  (await loadState(ctx)).present;

/** Drop the memo so the next accessor call re-reads `.git/shallow`. */
export const invalidateShallowSet = (ctx: Context): void => {
  shallowCache.delete(ctx.session);
};
