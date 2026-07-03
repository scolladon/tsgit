import type { AuthorIdentity } from '../../domain/objects/author-identity.js';
import type { Context } from '../../ports/context.js';
import { readConfig } from './config-read.js';

// Git falls back to the system `username@hostname`, which the browser and
// memory adapters cannot produce. tsgit uses a fixed portable identity so a
// reflog write never depends on platform identity probing.
const FALLBACK_NAME = 'tsgit';
const FALLBACK_EMAIL = 'tsgit@localhost';

// A `user.signingKey`-only config (no name/email) does not count as an
// identity — reflog entries still fall back to the portable identity.
const resolveNameEmail = (
  user: { name?: string; email?: string } | undefined,
): { name: string; email: string } =>
  user?.name !== undefined && user?.email !== undefined
    ? { name: user.name, email: user.email }
    : { name: FALLBACK_NAME, email: FALLBACK_EMAIL };

/**
 * Committer identity for reflog entries: config `user.*` plus a fresh
 * timestamp, or a portable fallback when `user.*` is unset. Never throws —
 * reflog logging must not abort a ref update.
 */
export async function resolveReflogIdentity(ctx: Context): Promise<AuthorIdentity> {
  const config = await readConfig(ctx);
  const { name, email } = resolveNameEmail(config.user);
  return {
    name,
    email,
    timestamp: Math.floor(Date.now() / 1000),
    timezoneOffset: '+0000',
  };
}
