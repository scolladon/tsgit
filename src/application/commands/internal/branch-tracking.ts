import {
  trackingAmbiguous,
  trackingInheritRebaseMultiple,
  upstreamMissing,
  upstreamNotBranch,
} from '../../../domain/commands/error.js';
import { parseGitBoolean } from '../../../domain/config/config-ini.js';
import { errorDataCode } from '../../../domain/error-data-code.js';
import type { RefName } from '../../../domain/objects/index.js';
import { HEADS_PREFIX } from '../../../domain/refs/ref-prefixes.js';
import type { Context } from '../../../ports/context.js';
import { findLastEntry, readConfig } from '../../primitives/config-read.js';
import { getAllConfigValues, resolveConfigScopePath } from '../../primitives/config-scoped-read.js';
import { assertNoValuelessConfigAt } from '../../primitives/internal/valueless-config-guard.js';
import { updateConfigOperations } from '../../primitives/update-config.js';
import { mapsNamedSource } from './branch-merged.js';
import { isExcludedByNegativeRefspec } from './negative-refspec.js';
import { applyRefspec, parseRefspec } from './ref-spec.js';
import { dwimRefName } from './revision-name.js';

/** `--track[=direct|inherit]`: track the start point itself, or copy its own upstream. */
export type BranchTrack = 'direct' | 'inherit';

/** The upstream `branch.create` recorded — git's `branch '<n>' set up to track '<upstream>'`. */
export interface BranchUpstream {
  /** `branch.<name>.remote` — `.` when the upstream is a branch of this repository. */
  readonly remote: string;
  /**
   * Every `branch.<name>.merge` — the upstream refs as their remote names them:
   * one, except where `--track=inherit` copies a branch merging several.
   */
  readonly merges: ReadonlyArray<RefName>;
  /** Whether `branch.<name>.rebase = true` was recorded (`branch.autoSetupRebase`). */
  readonly rebase: boolean;
}

/** git's `enum branch_track`, as `create_branch` receives it. */
export type TrackMode = 'never' | 'remote' | 'always' | 'explicit' | 'inherit' | 'simple';

export interface TrackingRequest {
  readonly noTrack?: boolean;
  readonly track?: BranchTrack;
}

/** `branch.<n>.remote`'s pseudo-remote for "this repository". */
const LOCAL_REMOTE = '.';

/** `branch.autoSetupMerge`'s literals, compared case-sensitively before the boolean grammar. */
const CONFIGURED_MODES: ReadonlyMap<string, TrackMode> = new Map([
  ['always', 'always'],
  ['inherit', 'inherit'],
  ['simple', 'simple'],
]);

/** The command-line mode wins; otherwise `branch.autoSetupMerge`, defaulting to `remote`. */
export const resolveTrackMode = async (
  ctx: Context,
  request: TrackingRequest,
): Promise<TrackMode> => {
  if (request.noTrack === true) return 'never';
  if (request.track === 'inherit') return 'inherit';
  if (request.track === 'direct') return 'explicit';
  return configuredTrackMode(ctx);
};

const configuredTrackMode = async (ctx: Context): Promise<TrackMode> => {
  const last = await findLastEntry(ctx, 'branch', 'autoSetupMerge');
  if (last === undefined) return 'remote';
  const named = last.value === null ? undefined : CONFIGURED_MODES.get(last.value);
  if (named !== undefined) return named;
  const parsed = parseGitBoolean(last.value);
  return parsed.ok && !parsed.value ? 'never' : 'remote';
};

/** `--track` resolves a start point that names nothing to git's `upstream_missing`. */
export const asUpstreamMissing = (err: unknown, startPoint: string, mode: TrackMode): unknown =>
  mode === 'explicit' && errorDataCode(err) === 'BRANCH_NOT_FOUND'
    ? upstreamMissing(startPoint)
    : err;

/**
 * git's `dwim_branch_start`: the ref a start point names, kept only when it is
 * a local branch or a ref some remote fetches into. `--track` refuses any
 * other start point before the branch is written.
 */
export const trackableStartRef = async (
  ctx: Context,
  startPoint: string,
  mode: TrackMode,
): Promise<RefName | undefined> => {
  const ref = await dwimRefName(ctx, startPoint);
  if (ref !== undefined && (await isTrackable(ctx, ref))) return ref;
  if (mode === 'explicit') throw upstreamNotBranch(startPoint);
  return undefined;
};

const isTrackable = async (ctx: Context, ref: RefName): Promise<boolean> =>
  ref.startsWith(HEADS_PREFIX) || (await remoteSources(ctx, ref)).length > 0;

interface TrackingSource {
  /** `undefined` for a branch of this repository — git's NULL origin. */
  readonly remote: string | undefined;
  readonly merges: ReadonlyArray<RefName>;
}

interface RemoteSource {
  readonly remote: string;
  readonly merge: RefName;
}

/** Every remote whose fetch refspecs map onto `ref`, with the source each names. */
const remoteSources = async (ctx: Context, ref: RefName): Promise<ReadonlyArray<RemoteSource>> => {
  const sources: RemoteSource[] = [];
  for (const [remote, entry] of (await readConfig(ctx)).remote ?? []) {
    // Stryker disable next-line ArrayDeclaration: equivalent — the fallback stands in for a remote with no fetch refspec, and any element put in its place holds no colon, so mapsNamedSource passes it over and firstSource still ends in `undefined`.
    const merge = firstSource(entry.fetch ?? [], ref);
    if (merge !== undefined) sources.push({ remote, merge });
  }
  return sources;
};

/**
 * git's `remote_find_tracking`: the earliest fetch refspec whose destination
 * maps `ref` back — none when a negative refspec excludes `ref`.
 */
const firstSource = (specs: ReadonlyArray<string>, ref: RefName): RefName | undefined => {
  if (isExcludedByNegativeRefspec(specs, ref)) return undefined;
  for (const spec of specs) {
    if (!mapsNamedSource(spec)) continue;
    const { src, dst, ...rest } = parseRefspec(spec);
    const source = applyRefspec({ ...rest, src: dst, dst: src }, ref);
    if (source !== undefined) return source;
  }
  return undefined;
};

/**
 * git's `setup_tracking`, run once the branch is written: find the upstream
 * the mode asks for, record it in `branch.<name>.*` and report it.
 */
export const setupTracking = async (
  ctx: Context,
  branch: string,
  startRef: RefName,
  mode: TrackMode,
): Promise<BranchUpstream | undefined> => {
  const source =
    mode === 'inherit'
      ? await inheritedSource(ctx, startRef)
      : await matchedSource(ctx, startRef, mode);
  if (source === undefined) return undefined;
  if (mode === 'simple' && source.merges[0] !== `${HEADS_PREFIX}${branch}`) return undefined;
  return installUpstream(ctx, branch, source);
};

const matchedSource = async (
  ctx: Context,
  startRef: RefName,
  mode: TrackMode,
): Promise<TrackingSource | undefined> => {
  const sources = await remoteSources(ctx, startRef);
  if (sources.length > 1) {
    throw trackingAmbiguous(
      startRef,
      sources.map((source) => source.remote),
    );
  }
  const [only] = sources;
  if (only !== undefined) return { remote: only.remote, merges: [only.merge] };
  return mode === 'always' || mode === 'explicit'
    ? { remote: undefined, merges: [startRef] }
    : undefined;
};

/** git's `inherit_tracking`: the start branch's own `remote` and `merge`, or a warning. */
const inheritedSource = async (
  ctx: Context,
  startRef: RefName,
): Promise<TrackingSource | undefined> => {
  const bare = startRef.startsWith(HEADS_PREFIX) ? startRef.slice(HEADS_PREFIX.length) : startRef;
  const tracking = (await readConfig(ctx)).branch?.get(bare);
  if (tracking?.remote === undefined) {
    ctx.logger?.warn?.('asked to inherit tracking, but no remote is set', { branch: bare });
    return undefined;
  }
  if (tracking.merge === undefined) {
    ctx.logger?.warn?.('asked to inherit tracking, but no merge configuration is set', {
      branch: bare,
    });
    return undefined;
  }
  return { remote: tracking.remote, merges: await mergesOf(ctx, bare) };
};

/**
 * Every `branch.<bare>.merge` value, in config order — git's `branch->merge`,
 * whose read dies on a valueless entry.
 */
const mergesOf = async (ctx: Context, bare: string): Promise<ReadonlyArray<RefName>> => {
  const { values } = await getAllConfigValues({ ctx, key: `branch.${bare}.merge` });
  const valueless = values.find(({ value }) => value === null);
  if (valueless !== undefined) {
    const path = await resolveConfigScopePath(ctx, valueless.scope);
    await assertNoValuelessConfigAt(ctx, path, 'branch', bare, ['merge']);
  }
  return values.map(({ value }) => value as RefName);
};

/**
 * git's `install_branch_config_multiple_remotes`: rebasing onto more than one
 * upstream dies before anything is recorded, and a branch of this repository
 * never records itself as its own upstream.
 */
const installUpstream = async (
  ctx: Context,
  branch: string,
  source: TrackingSource,
): Promise<BranchUpstream | undefined> => {
  const { merges } = source;
  const rebase = await shouldSetupRebase(ctx, source.remote);
  if (rebase && merges.length > 1) throw trackingInheritRebaseMultiple(merges);
  if (source.remote === undefined && merges.includes(`${HEADS_PREFIX}${branch}` as RefName)) {
    ctx.logger?.warn?.('not setting a branch as its own upstream', { branch });
    return undefined;
  }
  const remote = source.remote ?? LOCAL_REMOTE;
  const at = { section: 'branch', subsection: branch } as const;
  await updateConfigOperations(ctx, [
    { kind: 'set', ...at, key: 'remote', value: remote },
    { kind: 'removeEntry', ...at, key: 'merge' },
    ...merges.map((merge) => ({ kind: 'appendEntry', ...at, key: 'merge', value: merge }) as const),
    ...(rebase ? [{ kind: 'set', ...at, key: 'rebase', value: 'true' } as const] : []),
  ]);
  return { remote, merges, rebase };
};

/** git's `should_setup_rebase` over `branch.autoSetupRebase`. */
const shouldSetupRebase = async (ctx: Context, remote: string | undefined): Promise<boolean> => {
  const value = (await findLastEntry(ctx, 'branch', 'autoSetupRebase'))?.value;
  if (value === 'always') return true;
  if (value === 'local') return remote === undefined;
  if (value === 'remote') return remote !== undefined;
  return false;
};
