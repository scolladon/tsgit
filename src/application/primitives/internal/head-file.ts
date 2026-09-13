/**
 * The single reader for `${gitDir}/HEAD`, shared by the operational gate
 * (`repo-state.ts`'s `hasUsableHead`) and the files ref store's
 * `resolveDirect('HEAD')` arm — neither constructs the other; both import
 * this module.
 */
import type { Context } from '../../../ports/context.js';
import type { FileStat } from '../../../ports/file-system.js';

export type HeadFile =
  | { readonly kind: 'symlink'; readonly linkText: string }
  | { readonly kind: 'file'; readonly content: string }
  | { readonly kind: 'unusable'; readonly cause: unknown };

interface HeadSlot {
  readonly identity: string | undefined;
  readonly head: HeadFile;
  trusted: boolean;
}

/**
 * Keyed on `Context` OBJECT identity, deliberately not on `ctx.session`:
 * the slot holds bytes read through `ctx.fs`, and a derived Context built
 * as a spread with a proxied `fs` must never be served bytes that proxy
 * never produced.
 */
const slots = new WeakMap<Context, HeadSlot>();

const headPath = (ctx: Context): string => `${ctx.layout.gitDir}/HEAD`;

/**
 * The `lstat` identity a slot is trusted against — `undefined` on an
 * adapter reporting `ino: 0` (memory, browser), which degenerates the key
 * and must never be trusted across commands.
 */
const computeIdentity = (stat: FileStat): string | undefined =>
  stat.ino === 0
    ? undefined
    : `${stat.mtimeNs ?? stat.mtimeMs}:${stat.ctimeNs ?? stat.ctimeMs}:${stat.ino}:${stat.size}`;

const TEXT_DECODER = new TextDecoder();

/**
 * `openWithNoFollow` → `handle.stat()` → `read` → `close`: the identity
 * comes from the SAME open file the bytes were read from, so the two can
 * never disagree (unlike stat-then-open, which races a rewrite in between).
 */
async function readViaHandle(
  ctx: Context,
  path: string,
): Promise<{ readonly content: string; readonly identity: string | undefined }> {
  const handle = await ctx.fs.openWithNoFollow(path, 'read');
  try {
    const stat = await handle.stat();
    const buffer = new Uint8Array(stat.size);
    const bytesRead = await handle.read(buffer, 0, stat.size, 0);
    return {
      content: TEXT_DECODER.decode(buffer.subarray(0, bytesRead)),
      identity: computeIdentity(stat),
    };
  } finally {
    await handle.close();
  }
}

/**
 * Content for a non-symlink leaf. A directory falls through to `readUtf8`
 * rather than a dedicated branch: every adapter already refuses reading a
 * directory as UTF-8 (memory: `FILE_NOT_FOUND`; Node: an EISDIR-mapped
 * refusal), so the existing catch-all folds it into `unusable` exactly like
 * every other read failure, with no extra branch to test.
 *
 * `ino === 0` (memory, browser) is the SAME discriminator that decides
 * trust also decides the reader: those adapters re-read via `readUtf8`, and
 * the browser adapter's `openWithNoFollow` throws `UNSUPPORTED_OPERATION`
 * regardless. Nothing here branches on `ctx.runtime`.
 */
async function readRegularContent(
  ctx: Context,
  path: string,
  stat: FileStat,
): Promise<{ readonly content: string; readonly identity: string | undefined }> {
  if (stat.isDirectory || stat.ino === 0) {
    return { content: await ctx.fs.readUtf8(path), identity: undefined };
  }
  return readViaHandle(ctx, path);
}

async function contentFromStat(
  ctx: Context,
  path: string,
  stat: FileStat,
): Promise<{ readonly head: HeadFile; readonly identity: string | undefined }> {
  try {
    if (stat.isSymbolicLink) {
      const linkText = await ctx.fs.readlink(path);
      return { head: { kind: 'symlink', linkText }, identity: computeIdentity(stat) };
    }
    const { content, identity } = await readRegularContent(ctx, path, stat);
    return { head: { kind: 'file', content }, identity };
  } catch (cause) {
    return { head: { kind: 'unusable', cause }, identity: undefined };
  }
}

/** `lstat` plus the content read it selects — the full miss path, one `lstat`. */
async function readFresh(
  ctx: Context,
  path: string,
): Promise<{ readonly head: HeadFile; readonly identity: string | undefined }> {
  let stat: FileStat;
  try {
    stat = await ctx.fs.lstat(path);
  } catch (cause) {
    return { head: { kind: 'unusable', cause }, identity: undefined };
  }
  return contentFromStat(ctx, path, stat);
}

/**
 * The gate's read: ALWAYS `lstat`s (freshness cannot be skipped), but skips
 * the CONTENT read when the fresh identity matches the slot's — the 5-hop
 * miss collapses to the 1-hop `lstat` alone on a repeat call. A read here
 * always marks the slot trusted, whether or not the identity was
 * comparable: that is the same-command sharing `readHeadFile` relies on;
 * only cross-command reuse needs `identity !== undefined`.
 */
export const validateHead = async (ctx: Context): Promise<HeadFile> => {
  const path = headPath(ctx);
  let stat: FileStat;
  try {
    stat = await ctx.fs.lstat(path);
  } catch (cause) {
    slots.delete(ctx);
    return { kind: 'unusable', cause };
  }
  const identity = computeIdentity(stat);
  const existing = slots.get(ctx);
  if (identity !== undefined && existing !== undefined && existing.identity === identity) {
    existing.trusted = true;
    return existing.head;
  }
  const outcome = await contentFromStat(ctx, path, stat);
  slots.set(ctx, { identity: outcome.identity, head: outcome.head, trusted: true });
  return outcome.head;
};

/**
 * The store's read: a trusted slot (one `validateHead` already populated in
 * THIS command) is returned with zero I/O. Otherwise this runs the same
 * miss path `validateHead` does, but never marks the result trusted — only
 * the gate's own read is allowed to promise "this is fresh enough to
 * reuse", so a primitive-only sequence that never calls the gate
 * re-validates by `lstat` on every call.
 */
export const readHeadFile = async (ctx: Context): Promise<HeadFile> => {
  const existing = slots.get(ctx);
  if (existing?.trusted) {
    return existing.head;
  }
  const outcome = await readFresh(ctx, headPath(ctx));
  slots.set(ctx, { identity: outcome.identity, head: outcome.head, trusted: false });
  return outcome.head;
};

/** Drop `ctx`'s slot — called after any write to `${gitDir}/HEAD`. */
export const invalidateHeadSlot = (ctx: Context): void => {
  slots.delete(ctx);
};
