import type { PathPolicy } from '../adapters/node/path-policy.js';
import type { LayoutProbe } from '../ports/layout-probe.js';
import type { RepositoryLayoutInput } from '../repository.js';
import { findLayout, type WalkOutcome } from './find-layout.js';
import { type RepositoryFormat, readRepositoryFormat } from './read-repository-format.js';

/**
 * The work tree a `finishLayout` call resolved, plus whether the work-tree
 * config is bogus (`core.bare` and `core.worktree` both set). Kept as one
 * shape rather than two return values so the two facts travel together and
 * `finishLayout` cannot forget to fold in the bogus flag.
 */
interface WorkTreeResolution {
  readonly workDir?: string;
  readonly workTreeConfigBogus?: boolean;
}

/**
 * A discovered `.git` entry whose `commonDir` differs from its own `gitDir`
 * is a linked worktree's admin dir (the `commondir` file is the ONLY thing
 * that makes them differ — a submodule or `--separate-git-dir` gitdir has no
 * `commondir` file and so is its own common dir). `core.bare` lives in the
 * SHARED config, so a bare main repo's `core.bare = true` is visible from
 * every one of its linked worktrees too — but a linked worktree always HAS a
 * work tree (that is what makes it a worktree), independent of what the
 * shared config says about the main checkout. Measured: `--is-bare-repository`
 * is `false` from inside a linked worktree of a bare repo even though the
 * shared config's `core.bare` reads `true`.
 */
const isLinkedWorktreeAdmin = (outcome: WalkOutcome): boolean =>
  outcome.route === 'DISCOVERED' && outcome.commonDir !== undefined;

/**
 * The work-tree precedence: `core.bare` true means no work tree (and marks
 * the config bogus when `core.worktree` is ALSO set) — UNLESS this gitDir is
 * a linked worktree's own admin dir, which always has one; an explicit
 * `core.worktree` wins next, absolute verbatim or resolved lexically against
 * `gitDir` when relative (the node shim realpaths the result afterward —
 * `core.worktree` resolution is physical, but this tier stays lexical so
 * sandboxed adapters, which have no realpath, resolve identically); otherwise
 * the route decides: the directory holding a discovered `.git` entry, or no
 * work tree for a bare-shaped gitDir found by cwd-is-gitdir discovery.
 */
const resolveWorkTree = (
  outcome: WalkOutcome,
  fmt: RepositoryFormat,
  bareCfg: boolean | undefined,
  pathPolicy: PathPolicy,
): WorkTreeResolution => {
  if (bareCfg === true && !isLinkedWorktreeAdmin(outcome)) {
    return fmt.worktree !== undefined ? { workTreeConfigBogus: true } : {};
  }
  if (fmt.worktree !== undefined) {
    const workDir = pathPolicy.isAbsolute(fmt.worktree)
      ? pathPolicy.resolve(fmt.worktree)
      : pathPolicy.resolve(pathPolicy.join(outcome.gitDir, fmt.worktree));
    return { workDir };
  }
  if (outcome.route === 'DISCOVERED') return { workDir: outcome.origin };
  return {};
};

/**
 * Stages 2–4 of layout resolution, given a structural `WalkOutcome` (from the
 * walk, or from a fixed-entry shim that has no walk at all): read the
 * repository-format config keys, decide the work tree by precedence, then
 * derive `bare`. `bareOverride`, when given, wins outright over
 * `core.bare` — the argument-tier-beats-config-tier rule every explicit
 * layout option follows (the browser shim's own `bare` option is the one
 * caller in this part; the core `openRepository` option is not yet).
 */
export const finishLayout = async (
  probe: LayoutProbe,
  outcome: WalkOutcome,
  pathPolicy: PathPolicy,
  bareOverride?: boolean,
): Promise<RepositoryLayoutInput> => {
  const commonDir = outcome.commonDir ?? outcome.gitDir;
  const fmt = await readRepositoryFormat(probe, outcome.gitDir, commonDir, pathPolicy);
  const bareCfg = bareOverride ?? fmt.bare;
  const { workDir, workTreeConfigBogus } = resolveWorkTree(outcome, fmt, bareCfg, pathPolicy);
  // `bareCfg` unset (neither an override nor `core.bare`) is TRUTHY here —
  // git's `is_bare_repository_cfg` defaults to -1, not 0.
  const bare = bareCfg !== false && workDir === undefined;
  return {
    gitDir: outcome.gitDir,
    ...(outcome.commonDir !== undefined ? { commonDir: outcome.commonDir } : {}),
    ...(workDir !== undefined ? { workDir } : {}),
    bare,
    ...(workTreeConfigBogus === true ? { workTreeConfigBogus: true as const } : {}),
  };
};

/**
 * Resolve the full physical layout for `cwd` via discovery: walk up looking
 * for a `.git` entry or a cwd-is-gitdir match, then apply Stages 2–4.
 * `undefined` when the walk finds nothing — callers default to a fresh
 * (non-bare) repository at `cwd` for `init`/`clone` to bootstrap into, or
 * surface `NOT_A_REPOSITORY` at first command.
 */
export const resolveLayout = async (
  probe: LayoutProbe,
  cwd: string,
  pathPolicy: PathPolicy,
): Promise<RepositoryLayoutInput | undefined> => {
  const outcome = await findLayout(probe, cwd, pathPolicy);
  if (outcome === undefined) return undefined;
  return finishLayout(probe, outcome, pathPolicy);
};
