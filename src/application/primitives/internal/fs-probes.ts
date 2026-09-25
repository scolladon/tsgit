import { errorDataCode } from '../../../domain/error-data-code.js';
import type { FileStat, FileSystem } from '../../../ports/file-system.js';

async function lstatFallback(fs: FileSystem, path: string): Promise<FileStat | undefined> {
  try {
    return await fs.lstat(path);
  } catch (err) {
    if (errorDataCode(err) === 'FILE_NOT_FOUND') return undefined;
    throw err;
  }
}

/**
 * `lstat`, answered without a refusal where the path is absent. Uses
 * `fs.tryLstat` when the adapter provides it (invoked on `fs` so the method
 * reads its own receiver); otherwise falls back to `lstat` and folds
 * `FILE_NOT_FOUND` (classified structurally via `errorDataCode`, never
 * `instanceof`) into `undefined`. Every other refusal still rejects.
 */
export const lstatIfPresent = async (
  fs: FileSystem,
  path: string,
): Promise<FileStat | undefined> => {
  if (fs.tryLstat === undefined) return lstatFallback(fs, path);
  return fs.tryLstat(path);
};

async function readUtf8Fallback(fs: FileSystem, path: string): Promise<string | undefined> {
  try {
    return await fs.readUtf8(path);
  } catch (err) {
    if (errorDataCode(err) === 'FILE_NOT_FOUND') return undefined;
    throw err;
  }
}

/**
 * `readUtf8`'s twin of {@link lstatIfPresent}: answered without a refusal
 * where the path is absent, via `fs.tryReadUtf8` when present, otherwise the
 * same `errorDataCode`-classified `readUtf8` fallback.
 */
export const readUtf8IfPresent = async (
  fs: FileSystem,
  path: string,
): Promise<string | undefined> => {
  if (fs.tryReadUtf8 === undefined) return readUtf8Fallback(fs, path);
  return fs.tryReadUtf8(path);
};
