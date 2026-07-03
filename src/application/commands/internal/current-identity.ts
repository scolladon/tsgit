import type { AuthorIdentity } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { readConfig } from '../../primitives/config-read.js';
import { assertNoValuelessConfig } from '../../primitives/internal/valueless-config-guard.js';
import { resolveCommitter } from './commit-message.js';

/**
 * The current identity (config `user.name`/`user.email` + the current time),
 * used as author and/or committer by the commands that create commits without an
 * explicit identity. Falls back to `resolveCommitter`'s default when `[user]` is unset
 * or only partially configured — a signingKey-only `[user]` is not an identity.
 */
export const resolveCurrentIdentity = async (ctx: Context): Promise<AuthorIdentity> => {
  const config = await readConfig(ctx);
  const user = config.user;
  if (user?.name === undefined || user?.email === undefined) {
    await assertNoValuelessConfig(ctx, 'user', undefined, ['name', 'email']);
  }
  const configUser =
    user?.name !== undefined && user?.email !== undefined
      ? {
          name: user.name,
          email: user.email,
          timestamp: Math.floor(Date.now() / 1000),
          timezoneOffset: '+0000',
        }
      : undefined;
  return resolveCommitter(configUser !== undefined ? { configUser } : {});
};
