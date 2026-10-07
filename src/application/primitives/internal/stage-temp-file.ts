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

/**
 * git's `mks_tempfile`: writes `data` to `<stem><6 random characters>`,
 * created exclusively — an existing file or a planted symbolic link at the
 * name is never opened, a fresh name is drawn instead. Returns the path.
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
      if (errorDataCode(error) !== 'FILE_EXISTS') throw error;
    }
  }
  throw fileExists(`${stem}${TEMPLATE_SUFFIX}`);
};
