import type { AuthorIdentity } from '../../domain/objects/author-identity.js';
import type { Context } from '../../ports/context.js';
import { readConfig } from './config-read.js';

// Git falls back to the system `username@hostname`, which the browser and
// memory adapters cannot produce. tsgit uses a fixed portable identity so a
// reflog write never depends on platform identity probing.
const FALLBACK_NAME = 'tsgit';
const FALLBACK_EMAIL = 'tsgit@localhost';

/**
 * Committer identity for reflog entries: config `user.*` plus a fresh
 * timestamp, or a portable fallback when `user.*` is unset. Never throws —
 * reflog logging must not abort a ref update.
 */
export async function resolveReflogIdentity(ctx: Context): Promise<AuthorIdentity> {
  const config = await readConfig(ctx);
  const user = config.user;
  return {
    name: user === undefined ? FALLBACK_NAME : user.name,
    email: user === undefined ? FALLBACK_EMAIL : user.email,
    timestamp: Math.floor(Date.now() / 1000),
    timezoneOffset: '+0000',
  };
}
