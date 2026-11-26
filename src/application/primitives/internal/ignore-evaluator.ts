import type { IgnoreLevel, IgnoreRuleset } from '../../../domain/ignore/index.js';
import {
  directoryExclusion,
  leadingDirectoriesOf,
  matchBeneathLeadingDirectories,
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
   * Lazily load and cache the ruleset for a directory's `.gitignore`.
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
  const cache = new Map<FilePath | '', IgnoreRuleset>();
  const loadDirRules = async (dir: FilePath | ''): Promise<IgnoreRuleset> => {
    const cached = cache.get(dir);
    if (cached !== undefined) return cached;
    const loaded = (await readGitignore(ctx, dir, { caseFold })) ?? [];
    cache.set(dir, loaded);
    return loaded;
  };
  return { base, loadDirRules };
};

/** One ignore judgement for a command: rules read lazily, one verdict per leading directory. */
export interface IgnoreSession {
  /** git's verdict for one path, with the rule that decided it. */
  readonly match: (path: FilePath, isDirectory: boolean) => Promise<VerboseMatch>;
}

interface SessionState {
  readonly evaluator: IgnoreEvaluator;
  readonly stack: IgnoreLevel[];
  readonly entered: Map<FilePath, Promise<VerboseMatch | undefined>>;
  readonly resolved: Map<FilePath, VerboseMatch | undefined>;
}

const pushDirRules = async (state: SessionState, directory: FilePath): Promise<void> => {
  const rules = await state.evaluator.loadDirRules(directory);
  if (rules.length > 0) state.stack.push({ basedir: directory, rules, kind: 'gitignore' });
};

const enterDirectory = async (
  state: SessionState,
  directory: FilePath,
): Promise<VerboseMatch | undefined> => {
  const exclusion = directoryExclusion(state.stack, directory);
  if (exclusion === undefined) await pushDirRules(state, directory);
  state.resolved.set(directory, exclusion);
  return exclusion;
};

const rememberEntry = (
  state: SessionState,
  directory: FilePath,
): Promise<VerboseMatch | undefined> => {
  const entry = enterDirectory(state, directory);
  state.entered.set(directory, entry);
  return entry;
};

const exclusionOf = (state: SessionState, directory: FilePath): Promise<VerboseMatch | undefined> =>
  state.entered.get(directory) ?? rememberEntry(state, directory);

const settleLeadingDirectories = async (state: SessionState, path: FilePath): Promise<void> => {
  for (const directory of leadingDirectoriesOf(path)) {
    if ((await exclusionOf(state, directory)) !== undefined) return;
  }
};

export const createIgnoreSession = async (ctx: Context): Promise<IgnoreSession> => {
  const evaluator = await buildIgnoreEvaluator(ctx);
  const state: SessionState = {
    evaluator,
    stack: [...evaluator.base],
    entered: new Map(),
    resolved: new Map(),
  };
  return {
    match: async (path, isDirectory) => {
      await settleLeadingDirectories(state, path);
      return matchBeneathLeadingDirectories(state.stack, path, isDirectory, (directory) =>
        state.resolved.get(directory),
      );
    },
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
