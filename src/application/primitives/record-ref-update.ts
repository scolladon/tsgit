/**
 * The single reflog *writer*. Self-contained: reads config, applies the gate,
 * resolves identity, sanitises the message, and appends one entry. Callers
 * supply only a human-readable message.
 *
 * Owns its own file probe/append (rather than importing `reflog-store.ts`)
 * because this module is called BY the files backend (`ref-store.ts`), while
 * `reflog-store.ts`'s `readReflog`/`listReflogs` call back INTO that same
 * backend — sharing the probe would close an import cycle.
 */
import type { ObjectId, RefName } from '../../domain/objects/object-id.js';
import type { ReflogEntry } from '../../domain/reflog/reflog-entry.js';
import { sanitizeReflogMessage, serializeReflogLine } from '../../domain/reflog/reflog-format.js';
import { shouldAutocreateReflog } from '../../domain/reflog/should-log.js';
import type { Context } from '../../ports/context.js';
import { readConfig } from './config-read.js';
import { perWorktreeRefDir, reflogPath } from './path-layout.js';
import { resolveReflogIdentity } from './reflog-identity.js';

export interface RecordRefUpdateOptions {
  /** Skip the loggability gate and append regardless — `refs/stash`, which git always logs. */
  readonly unconditional?: boolean;
}

/**
 * Append a reflog entry for `ref` if logging applies. A no-op when the gate is
 * closed for `ref` — once a reflog file exists every update appends to it,
 * otherwise the `core.logAllRefUpdates` prefix rule decides.
 * `options.unconditional` skips that gate entirely.
 */
export async function recordRefUpdate(
  ctx: Context,
  ref: RefName,
  oldId: ObjectId,
  newId: ObjectId,
  message: string,
  options?: RecordRefUpdateOptions,
): Promise<void> {
  if (options?.unconditional !== true && !(await isLoggable(ctx, ref))) return;
  const identity = await resolveReflogIdentity(ctx);
  await appendReflogFile(ctx, ref, {
    oldId,
    newId,
    identity,
    message: sanitizeReflogMessage(message),
  });
}

async function isLoggable(ctx: Context, ref: RefName): Promise<boolean> {
  if (await reflogFileExists(ctx, ref)) return true;
  const config = await readConfig(ctx);
  return shouldAutocreateReflog(ref, config.core ?? {});
}

/** Whether `ref` has a reflog file — the files backend's own probe. */
async function reflogFileExists(ctx: Context, ref: RefName): Promise<boolean> {
  return ctx.fs.exists(reflogPath(perWorktreeRefDir(ctx, ref), ref));
}

/** Append one line to `ref`'s reflog, creating the file and parents as needed. */
async function appendReflogFile(ctx: Context, ref: RefName, entry: ReflogEntry): Promise<void> {
  await ctx.fs.appendUtf8(
    reflogPath(perWorktreeRefDir(ctx, ref), ref),
    serializeReflogLine(entry, ctx.hashConfig.hexLength),
  );
}
