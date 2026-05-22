/**
 * Read the `.git/info/sparse-checkout` pattern file and build the matcher
 * every sparse-aware consumer gates on. No working-tree mutation — pure read
 * side over ports + domain + `readConfig` (design §7.2).
 */
import { sparsePatternFileTooLarge } from '../../domain/commands/error.js';
import { TsgitError } from '../../domain/error.js';
import type { FilePath } from '../../domain/objects/object-id.js';
import {
  buildSparseMatcher,
  parseSparseCheckout,
  type SparseMatcher,
} from '../../domain/sparse/index.js';
import type { Context } from '../../ports/context.js';
import { readConfig } from './config-read.js';
import { sparseCheckoutPath } from './path-layout.js';

/** Hard cap (bytes) on the `.git/info/sparse-checkout` file, mirroring `MAX_GITIGNORE_BYTES`. */
export const MAX_SPARSE_PATTERN_FILE_BYTES = 1 * 1024 * 1024;

const DECODER = new TextDecoder();

/**
 * Read `.git/info/sparse-checkout` as UTF-8 text. An absent file yields
 * `undefined`; a file whose byte length exceeds
 * `MAX_SPARSE_PATTERN_FILE_BYTES` throws `SPARSE_PATTERN_FILE_TOO_LARGE`
 * (checked before decode so an over-cap file never reaches the decoder).
 */
export const readSparsePatternText = async (ctx: Context): Promise<string | undefined> => {
  const path = sparseCheckoutPath(ctx.layout.gitDir);
  let bytes: Uint8Array;
  try {
    bytes = await ctx.fs.read(path);
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'FILE_NOT_FOUND') return undefined;
    throw err;
  }
  if (bytes.byteLength > MAX_SPARSE_PATTERN_FILE_BYTES) {
    throw sparsePatternFileTooLarge(
      'info/sparse-checkout' as FilePath,
      bytes.byteLength,
      MAX_SPARSE_PATTERN_FILE_BYTES,
    );
  }
  return DECODER.decode(bytes);
};

/**
 * Build the sparse matcher for the current repository. Returns `undefined`
 * when `core.sparseCheckout` is falsy/absent — sparse is inactive and callers
 * behave exactly as a non-sparse repo. When active, the matcher is parsed in
 * the mode `core.sparseCheckoutCone` dictates; a cone file that degrades to
 * non-cone matching logs one warning.
 */
export const loadSparseMatcher = async (ctx: Context): Promise<SparseMatcher | undefined> => {
  const config = await readConfig(ctx);
  if (config.core?.sparseCheckout !== true) return undefined;
  // `config.core` is non-undefined here — the guard above already narrowed it.
  const coneRequested = config.core.sparseCheckoutCone === true;
  const text = await readSparsePatternText(ctx);
  const parsed = parseSparseCheckout(text ?? '', coneRequested);
  // Only an actual pattern file can be "not cone-shaped" — an absent file
  // (`text === undefined`) is not degraded, so it must not warn.
  if (parsed.degraded && text !== undefined) {
    ctx.logger?.warn?.(
      '.git/info/sparse-checkout is not cone-shaped; falling back to non-cone matching',
    );
  }
  return buildSparseMatcher(parsed.spec);
};
