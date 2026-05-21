/**
 * The single reflog *writer*. Self-contained: reads config, applies the gate,
 * resolves identity, sanitises the message, and appends one entry. Callers
 * supply only a human-readable message.
 */
import type { ObjectId, RefName } from '../../domain/objects/object-id.js';
import { sanitizeReflogMessage } from '../../domain/reflog/reflog-format.js';
import { shouldAutocreateReflog } from '../../domain/reflog/should-log.js';
import type { Context } from '../../ports/context.js';
import { readConfig } from './config-read.js';
import { resolveReflogIdentity } from './reflog-identity.js';
import { appendReflog, reflogExists } from './reflog-store.js';

/**
 * Append a reflog entry for `ref` if logging applies. A no-op when the gate is
 * closed for `ref` — once a reflog file exists every update appends to it,
 * otherwise the `core.logAllRefUpdates` prefix rule decides.
 */
export async function recordRefUpdate(
  ctx: Context,
  ref: RefName,
  oldId: ObjectId,
  newId: ObjectId,
  message: string,
): Promise<void> {
  if (!(await isLoggable(ctx, ref))) return;
  const identity = await resolveReflogIdentity(ctx);
  await appendReflog(ctx, ref, {
    oldId,
    newId,
    identity,
    message: sanitizeReflogMessage(message),
  });
}

async function isLoggable(ctx: Context, ref: RefName): Promise<boolean> {
  if (await reflogExists(ctx, ref)) return true;
  const config = await readConfig(ctx);
  return shouldAutocreateReflog(ref, config.core ?? {});
}
