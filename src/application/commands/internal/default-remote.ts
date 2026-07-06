import { invalidOption } from '../../../domain/commands/error.js';
import { DEFAULT_REMOTE } from '../../../domain/remote.js';
import type { ParsedConfig } from '../../primitives/config-read.js';

/**
 * Resolve the remote a tracking-aware command (`fetch`, `pull`, `submodule`)
 * should use, in git's precedence order: an explicit argument, then the
 * branch's configured tracking remote, then — when exactly one remote is
 * configured — that sole remote, and finally the implicit `origin`.
 */
export const defaultRemoteName = (
  config: ParsedConfig,
  explicit: string | undefined,
  branch: string | undefined,
): string =>
  explicit ??
  (branch !== undefined ? config.branch?.get(branch)?.remote : undefined) ??
  (config.remote !== undefined && config.remote.size === 1
    ? [...config.remote.keys()][0]
    : undefined) ??
  DEFAULT_REMOTE;

/**
 * Resolve the remote `push` should target, in git's precedence order: an
 * explicit argument, then the branch's configured push-remote
 * (`branch.<name>.pushRemote`), then the repo-wide push default
 * (`remote.pushDefault`), then the branch's tracking remote
 * (`branch.<name>.remote`), then — when exactly one remote is configured —
 * that sole remote, and finally the implicit `origin`. A detached HEAD
 * (`branch` undefined) skips both `branch.<name>.*` rungs entirely.
 */
export const resolvePushRemote = (
  config: ParsedConfig,
  explicit: string | undefined,
  branch: string | undefined,
): string =>
  explicit ??
  (branch !== undefined ? config.branch?.get(branch)?.pushRemote : undefined) ??
  config.remotePushDefault ??
  (branch !== undefined ? config.branch?.get(branch)?.remote : undefined) ??
  (config.remote !== undefined && config.remote.size === 1
    ? [...config.remote.keys()][0]
    : undefined) ??
  DEFAULT_REMOTE;

/**
 * First-pass sanity filter on remote names: alphanumerics, dot, dash,
 * underscore. Rejects obvious traversal vectors (slashes, control chars,
 * spaces) at the entry point so a hostile caller cannot smuggle a path
 * separator through a resolved remote name. NOT a sufficient guarantee on
 * its own — strings like `.git`, `..`, `a..b`, `a.lock` pass this regex but
 * produce invalid composed ref paths. The definitive guard is
 * `isSafeRefName(composed)` inside `updateTrackingCache` (and the contract
 * honored by `updateRef`), which runs `validateRefName` over the full
 * composed path.
 */
const REMOTE_NAME_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Guard any resolved remote name (explicit, config-tracked, or sole-remote
 * inferred) before it flows into a composed on-disk path such as
 * `refs/remotes/<remote>/...`. Every caller that turns a remote name into a
 * filesystem path must call this first — resolution alone does not
 * validate, since `branch.<name>.remote` and `[remote "<name>"]` are both
 * attacker-controllable config values.
 */
export const assertValidRemoteName = (remoteName: string): void => {
  if (!REMOTE_NAME_RE.test(remoteName)) {
    throw invalidOption('remote', `invalid remote name: ${remoteName}`);
  }
};
