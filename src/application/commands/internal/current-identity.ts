import type { AuthorIdentity } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { readConfig } from '../../primitives/config-read.js';
import { assertNoValuelessConfig } from '../../primitives/internal/valueless-config-guard.js';
import { resolveCommitter } from './commit-message.js';

/**
 * The current identity (config `user.name`/`user.email` + the current time) used
 * as the committer of a cherry-pick and as the author **and** committer of a
 * revert. Falls back to `resolveCommitter`'s default when `[user]` is unset.
 */
export const resolveCurrentIdentity = async (ctx: Context): Promise<AuthorIdentity> => {
  const config = await readConfig(ctx);
  const user = config.user;
  if (user === undefined) await assertNoValuelessConfig(ctx, 'user', undefined, ['name', 'email']); // equivalent-mutant: when user !== undefined both name and email are valued (readConfig only sets user when both are non-null), so the guard is always a no-op for that branch
  const configUser =
    user !== undefined
      ? {
          name: user.name,
          email: user.email,
          timestamp: Math.floor(Date.now() / 1000),
          timezoneOffset: '+0000',
        }
      : undefined;
  return resolveCommitter(configUser !== undefined ? { configUser } : {});
};
