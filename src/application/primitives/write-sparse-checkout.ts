/**
 * Write the `.git/info/sparse-checkout` pattern file. The command tier
 * computes the text (via `serializeCone` or raw non-cone lines); this
 * primitive only persists it (design §7.3).
 *
 * @writes
 *   surface: sparseCheckoutFile
 *   kind:    byte-identical
 *   format:  git-sparse-checkout
 */
import type { Context } from '../../ports/context.js';
import { sparseCheckoutPath } from './path-layout.js';

/**
 * Persist `text` to `.git/info/sparse-checkout`. The `.git/info` directory is
 * created defensively first — `writeUtf8` creates parents on every adapter,
 * but an explicit `mkdir` keeps the contract clear and survives adapters that
 * tighten that guarantee.
 */
export const writeSparsePatternText = async (ctx: Context, text: string): Promise<void> => {
  await ctx.fs.mkdir(`${ctx.layout.gitDir}/info`);
  await ctx.fs.writeUtf8(sparseCheckoutPath(ctx.layout.gitDir), text);
};
