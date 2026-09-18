import { invalidOption } from '../../../domain/commands/error.js';
import { DEFAULT_REMOTE } from '../../../domain/remote.js';
import type { ParsedConfig } from '../../primitives/config-read.js';
import { isValidRemoteName } from './remote-config.js';

/**
 * The configured remote, when exactly one is configured — the shared
 * "sole remote" rung consulted (at different priority) by both
 * `defaultRemoteName` and `resolvePushRemote`. `.keys().next().value` reads
 * the sole key without materializing a throwaway array.
 */
const soleRemote = (config: ParsedConfig): string | undefined =>
  config.remote !== undefined && config.remote.size === 1
    ? config.remote.keys().next().value
    : undefined;

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
  soleRemote(config) ??
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
  soleRemote(config) ??
  DEFAULT_REMOTE;

/**
 * Guard any resolved remote name (explicit, config-tracked, or sole-remote
 * inferred) before it flows into a composed on-disk path such as
 * `refs/remotes/<remote>/...`. Every caller that turns a remote name into a
 * filesystem path must call this first — resolution alone does not
 * validate, since `branch.<name>.remote` and `[remote "<name>"]` are both
 * attacker-controllable config values.
 *
 * The rule is git's own `valid_remote_name`, so every name `remote add` and
 * `remote rename` accept can be fetched from and pushed to — `a/b`, `a"b`
 * and `a]b` included. It is no weaker as a containment guard: a name that
 * passes composes a ref path `validateRefName` already accepts, and `..`,
 * a leading `/` and every control character are still rejected.
 */
export const assertValidRemoteName = (remoteName: string): void => {
  if (!isValidRemoteName(remoteName)) {
    throw invalidOption('remote', `invalid remote name: ${remoteName}`);
  }
};
