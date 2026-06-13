import type { AuthorIdentity } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { readConfig } from '../../primitives/config-read.js';
import { resolveCommitter } from './commit-message.js';
import { assertNoValuelessConfig } from './valueless-config-guard.js';

/**
 * The current identity (config `user.name`/`user.email` + the current time) used
 * as the committer of a cherry-pick and as the author **and** committer of a
 * revert. Falls back to `resolveCommitter`'s default when `[user]` is unset.
 */
export const resolveCurrentIdentity = async (ctx: Context): Promise<AuthorIdentity> => {
  const config = await readConfig(ctx);
  const user = config.user;
  if (user === undefined) await assertNoValuelessConfig(ctx, 'user', undefined, ['name', 'email']);
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
