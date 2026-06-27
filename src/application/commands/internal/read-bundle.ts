import type { ParsedBundleHeader } from '../../../domain/bundle/index.js';
import { parseBundleHeader } from '../../../domain/bundle/index.js';
import { bundleBadHeader, bundleReadFailed } from '../../../domain/commands/error.js';
import { TsgitError } from '../../../domain/error.js';
import type { Context } from '../../../ports/context.js';

export interface OpenedBundle {
  readonly header: ParsedBundleHeader;
  readonly packBytes: Uint8Array;
}

export const readBundle = async (ctx: Context, path: string): Promise<OpenedBundle> => {
  const bytes = await readOrThrow(ctx, path);
  const header = parseBundleHeader(bytes, path);
  const packBytes = bytes.subarray(header.packOffset);
  return { header, packBytes };
};

const readOrThrow = async (ctx: Context, path: string): Promise<Uint8Array> => {
  try {
    return await ctx.fs.read(path);
  } catch (err) {
    if (!(err instanceof TsgitError)) throw err;
    if (err.data.code === 'FILE_NOT_FOUND') throw bundleReadFailed(path);
    if (err.data.code === 'PERMISSION_DENIED') throw await mapPermissionDenied(ctx, path);
    throw err;
  }
};

const mapPermissionDenied = async (ctx: Context, path: string): Promise<TsgitError> => {
  const stat = await ctx.fs.stat(path);
  if (stat.isDirectory) return bundleBadHeader(path, 'not-a-bundle');
  return bundleReadFailed(path);
};
