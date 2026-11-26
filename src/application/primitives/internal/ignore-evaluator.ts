import type { IgnoreLevel, IgnoreRuleset } from '../../../domain/ignore/index.js';
import {
  chainExclusion,
  matchBeneathChain,
  parentDirectoryOf,
  type VerboseMatch,
} from '../../../domain/ignore/matcher-stack.js';
import type { FilePath } from '../../../domain/objects/object-id.js';
import type { Context } from '../../../ports/context.js';
import { readConfig } from '../config-read.js';
import type { IgnorePredicate } from './ignore-predicate.js';
import { readGitignore, readGlobalExcludes, readInfoExclude } from './read-gitignore.js';

export interface IgnoreEvaluator {
  /** Base levels available before the walk begins (global → info → repo-root, in order). */
  readonly base: ReadonlyArray<IgnoreLevel>;
  /**
   * Read the ruleset of a directory's `.gitignore`; an absent file is an empty
   * ruleset. Nothing is kept: the session asks once per directory.
   * `dir === ''` is the repo root; non-root values are POSIX-relative
   * `FilePath`s (no trailing slash).
   */
  readonly loadDirRules: (dir: FilePath | '') => Promise<IgnoreRuleset>;
}

/**
 * Build an `IgnoreEvaluator` from the four repository-wide ignore sources.
 * Per-directory `.gitignore` files are NOT loaded eagerly —
 * the ignore session loads them on demand, one leading directory at a
 * time, so nothing at or beneath an excluded directory is ever read.
 */
export const buildIgnoreEvaluator = async (ctx: Context): Promise<IgnoreEvaluator> => {
  const caseFold = (await readConfig(ctx)).core?.ignoreCase === true;
  const base: IgnoreLevel[] = [];
  const global = await readGlobalExcludes(ctx, { caseFold });
  if (global !== undefined) base.push({ basedir: '', rules: global, kind: 'global' });
  const info = await readInfoExclude(ctx, { caseFold });
  if (info !== undefined) base.push({ basedir: '', rules: info, kind: 'info' });
  const root = await readGitignore(ctx, '', { caseFold });
  if (root !== undefined) base.push({ basedir: '', rules: root, kind: 'gitignore' });
  const loadDirRules = async (dir: FilePath | ''): Promise<IgnoreRuleset> =>
    (await readGitignore(ctx, dir, { caseFold })) ?? [];
  return { base, loadDirRules };
};

/** One ignore judgement for a command: rules read lazily, one outcome per directory chain. */
export interface IgnoreSession {
  /** git's verdict for one path, with the rule that decided it. */
  readonly match: (path: FilePath, isDirectory: boolean) => Promise<VerboseMatch>;
}

type ChainOutcome = Promise<VerboseMatch | undefined>;

interface SessionState {
  readonly evaluator: IgnoreEvaluator;
  readonly stack: IgnoreLevel[];
  /** The first excluded directory on each directory's chain, root-first; the root has none. */
  readonly chains: Map<FilePath | '', ChainOutcome>;
}

const pushDirRules = async (state: SessionState, directory: FilePath): Promise<void> => {
  const rules = await state.evaluator.loadDirRules(directory);
  if (rules.length > 0) state.stack.push({ basedir: directory, rules, kind: 'gitignore' });
};

const resolveChain = async (
  state: SessionState,
  directory: FilePath,
  above: ChainOutcome,
): ChainOutcome => {
  const exclusion = chainExclusion(state.stack, directory, await above);
  if (exclusion === undefined) await pushDirRules(state, directory);
  return exclusion;
};

const rememberChain = (
  state: SessionState,
  directory: FilePath,
  above: ChainOutcome,
): ChainOutcome => {
  const chain = resolveChain(state, directory, above);
  state.chains.set(directory, chain);
  return chain;
};

// Walks up to the nearest directory whose chain is known, then settles the missing ones
// root-first. A loop, not a recursion: a path may hold more directories than the call stack
// holds frames. The root's chain is always known, so the walk ends before it.
const settleChain = (state: SessionState, directory: FilePath): ChainOutcome => {
  const missing: FilePath[] = [];
  let at: FilePath | '' = directory;
  let known = state.chains.get(at);
  while (known === undefined) {
    missing.push(at as FilePath);
    at = parentDirectoryOf(at as FilePath);
    known = state.chains.get(at);
  }
  return missing.reduceRight((above, next) => rememberChain(state, next, above), known);
};

const chainOf = (state: SessionState, directory: FilePath | ''): ChainOutcome =>
  state.chains.get(directory) ?? settleChain(state, directory as FilePath);

export const createIgnoreSession = async (ctx: Context): Promise<IgnoreSession> => {
  const evaluator = await buildIgnoreEvaluator(ctx);
  const state: SessionState = {
    evaluator,
    stack: [...evaluator.base],
    chains: new Map([['', Promise.resolve(undefined)]]),
  };
  return {
    match: async (path, isDirectory) =>
      matchBeneathChain(
        state.stack,
        path,
        isDirectory,
        await chainOf(state, parentDirectoryOf(path)),
      ),
  };
};

/**
 * Build the ignore predicate shared by the walk and the pre-flight checks. One session backs
 * every call: a path beneath an excluded directory is ignored, and nothing at or beneath that
 * directory is read.
 */
export const buildRepoIgnorePredicate = async (ctx: Context): Promise<IgnorePredicate> => {
  const session = await createIgnoreSession(ctx);
  return async (path, isDirectory) =>
    (await session.match(path, isDirectory)).verdict === 'ignored';
};
