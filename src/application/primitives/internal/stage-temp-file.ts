import { fileExists } from '../../../domain/error.js';
import { errorDataCode } from '../../../domain/error-data-code.js';
import type { Context } from '../../../ports/context.js';

const SUFFIX_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const SUFFIX_LENGTH = 6;
/** Bounds the retry loop — a defence-in-depth ceiling, not an expected path. */
const MAX_ATTEMPTS = 8;
/** How a refusal names the template, as `mkstemp` spells it. */
const TEMPLATE_SUFFIX = 'XXXXXX';

/** Not security-sensitive: the exclusive create, not the name, is what refuses a planted file. */
const randomSuffix = (): string => {
  let suffix = '';
  for (let i = 0; i < SUFFIX_LENGTH; i += 1) {
    suffix += SUFFIX_ALPHABET[Math.floor(Math.random() * SUFFIX_ALPHABET.length)];
  }
  return suffix;
};

/** git's `delete_tempfile`: removes a staged file, which may be partly written or never created. */
export const removeIgnoringMissing = async (ctx: Context, path: string): Promise<void> => {
  try {
    await ctx.fs.rm(path);
  } catch (error) {
    if (errorDataCode(error) !== 'FILE_NOT_FOUND') throw error;
  }
};

/**
 * git's `mks_tempfile`: writes `data` to `<stem><6 random characters>`,
 * created exclusively — an existing file or a planted symbolic link at the
 * name is never opened, a fresh name is drawn instead. A write failing for
 * any other reason removes what it may have left before the failure
 * propagates. Returns the path. The file takes the file system's default mode:
 * the `FileSystem` port's exclusive write carries no mode, so git's `0600` is
 * not applied.
 */
export const stageTempFile = async (
  ctx: Context,
  stem: string,
  data: Uint8Array,
): Promise<string> => {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const candidate = `${stem}${randomSuffix()}`;
    try {
      await ctx.fs.writeExclusive(candidate, data);
      return candidate;
    } catch (error) {
      if (errorDataCode(error) === 'FILE_EXISTS') continue;
      await removeIgnoringMissing(ctx, candidate);
      throw error;
    }
  }
  throw fileExists(`${stem}${TEMPLATE_SUFFIX}`);
};
