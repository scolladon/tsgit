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
import { errorDataCode } from '../../domain/error-data-code.js';
import type { ObjectId, RefName } from '../../domain/objects/object-id.js';
import type { ReflogEntry } from '../../domain/reflog/reflog-entry.js';
import { sanitizeReflogMessage, serializeReflogLine } from '../../domain/reflog/reflog-format.js';
import { shouldAutocreateReflog } from '../../domain/reflog/should-log.js';
import type { Context } from '../../ports/context.js';
import { type ParsedConfig, readConfig } from './config-read.js';
import { removeEmptyDirectoryTree } from './internal/empty-directories.js';
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
 *
 * Reads config exactly ONCE and threads it into both consumers (the
 * loggability gate and identity resolution) rather than letting each read
 * it on its own — under an open epoch both reads are stat-free anyway; this
 * fold removes the second one's promise hop regardless.
 */
export async function recordRefUpdate(
  ctx: Context,
  ref: RefName,
  oldId: ObjectId,
  newId: ObjectId,
  message: string,
  options?: RecordRefUpdateOptions,
): Promise<void> {
  const config = await readConfig(ctx);
  if (options?.unconditional !== true && !(await isLoggable(ctx, ref, config))) return;
  const identity = await resolveReflogIdentity(ctx, config);
  await appendReflogFile(ctx, ref, {
    oldId,
    newId,
    identity,
    message: sanitizeReflogMessage(message),
  });
}

async function isLoggable(ctx: Context, ref: RefName, config: ParsedConfig): Promise<boolean> {
  if (await reflogFileExists(ctx, ref)) return true;
  return shouldAutocreateReflog(ref, config.core ?? {});
}

/** Whether `ref` has a reflog file — the files backend's own probe. A
 *  directory at the path is no log, as git's `EISDIR` open reads it. */
async function reflogFileExists(ctx: Context, ref: RefName): Promise<boolean> {
  try {
    return (await ctx.fs.stat(reflogPath(perWorktreeRefDir(ctx, ref), ref))).isFile;
  } catch (err) {
    if (errorDataCode(err) === 'FILE_NOT_FOUND') return false;
    throw err;
  }
}

/** Append one line to `ref`'s reflog, creating the file and parents as needed
 *  — over a tree of empty directories once it is removed, as git's log setup
 *  removes one. */
async function appendReflogFile(ctx: Context, ref: RefName, entry: ReflogEntry): Promise<void> {
  const path = reflogPath(perWorktreeRefDir(ctx, ref), ref);
  const line = serializeReflogLine(entry, ctx.hashConfig.hexLength);
  try {
    await ctx.fs.appendUtf8(path, line);
  } catch (err) {
    await clearEmptyLogDirectory(ctx, path, err);
    await ctx.fs.appendUtf8(path, line);
  }
}

/** Rethrows `refusal` unless it is the `PERMISSION_DENIED` a directory at
 *  `path` produces and that directory held only empty directories, now
 *  removed. */
async function clearEmptyLogDirectory(ctx: Context, path: string, refusal: unknown): Promise<void> {
  if (errorDataCode(refusal) !== 'PERMISSION_DENIED') throw refusal;
  if (!(await ctx.fs.stat(path)).isDirectory) throw refusal;
  if (!(await removeEmptyDirectoryTree(ctx, path))) throw refusal;
}
