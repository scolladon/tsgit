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
import { directoryNotEmpty } from '../../domain/error.js';
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
  const write = await prepareRefUpdate(ctx, ref, options);
  if (write === undefined) return;
  await commitRefUpdate(ctx, ref, write, oldId, newId, message);
}

/** An open loggability gate, carrying the config both halves share so the
 *  second never re-reads it. */
export interface ReflogWrite {
  readonly config: ParsedConfig;
}

/**
 * git's `log_ref_setup`, run before any lockfile is renamed into place: when
 * the gate is open it makes `ref`'s log path writable, removing a tree of
 * empty directories there and refusing anything else — so a blocked log path
 * refuses BEFORE the ref changes, as git's own log-then-rename order does.
 * `undefined` when the gate is closed, which is also git's answer for a
 * directory at the path it was never going to create a log at.
 */
export async function prepareRefUpdate(
  ctx: Context,
  ref: RefName,
  options?: RecordRefUpdateOptions,
): Promise<ReflogWrite | undefined> {
  const config = await readConfig(ctx);
  const path = reflogPath(perWorktreeRefDir(ctx, ref), ref);
  const kind = await reflogPathKind(ctx, path);
  // An existing log is appended to whatever the autocreate rule says, as
  // git's plain `O_APPEND` open does.
  if (kind === 'file') return { config };
  const autocreate =
    options?.unconditional === true || shouldAutocreateReflog(ref, config.core ?? {});
  if (!autocreate) return undefined;
  if (kind === 'directory') await clearLogDirectory(ctx, path);
  return { config };
}

/** Appends `ref`'s entry through an open gate. */
export async function commitRefUpdate(
  ctx: Context,
  ref: RefName,
  write: ReflogWrite,
  oldId: ObjectId,
  newId: ObjectId,
  message: string,
): Promise<void> {
  const identity = await resolveReflogIdentity(ctx, write.config);
  await appendReflogFile(ctx, ref, {
    oldId,
    newId,
    identity,
    message: sanitizeReflogMessage(message),
  });
}

/** What sits at the log path: git reads a directory there (`EISDIR`) as no
 *  log at all when it is not about to create one. */
async function reflogPathKind(
  ctx: Context,
  path: string,
): Promise<'file' | 'directory' | 'absent'> {
  try {
    const stat = await ctx.fs.stat(path);
    if (stat.isFile) return 'file';
    return stat.isDirectory ? 'directory' : 'absent';
  } catch (err) {
    if (errorDataCode(err) === 'FILE_NOT_FOUND') return 'absent';
    throw err;
  }
}

/** git's race-proof log create over a directory: a tree of empty directories
 *  is removed, anything else refuses ("there are still logs under"). */
async function clearLogDirectory(ctx: Context, path: string): Promise<void> {
  if (await removeEmptyDirectoryTree(ctx, path)) return;
  throw directoryNotEmpty(path);
}

/** Append one line to `ref`'s reflog, creating the file and parents as
 *  needed — the path is already settable, {@link prepareRefUpdate} saw to
 *  that. */
async function appendReflogFile(ctx: Context, ref: RefName, entry: ReflogEntry): Promise<void> {
  const path = reflogPath(perWorktreeRefDir(ctx, ref), ref);
  await ctx.fs.appendUtf8(path, serializeReflogLine(entry, ctx.hashConfig.hexLength));
}
