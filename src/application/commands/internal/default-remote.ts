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
