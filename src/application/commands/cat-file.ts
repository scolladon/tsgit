/**
 * Tier-1 `catFile` command — wraps the streaming `catFileBatch` primitive in
 * a request/response shape matching the other v2 commands (`submodules`,
 * `log`, `reflog`). String ids are coerced at the boundary via
 * `ObjectId.from`, which throws `INVALID_OBJECT_ID` on malformed input
 * before any read happens.
 *
 * For streaming use cases, callers reach for `repo.primitives.catFileBatch`
 * directly — see `docs/design/cat-file-batch.md` §2.
 */

import { ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { catFileBatch } from '../primitives/cat-file-batch.js';
import type { CatFileBatchEntry, CatFileBatchOptions } from '../primitives/types.js';
import { assertRepository } from './internal/repo-state.js';

export type { CatFileBatchEntry };

export interface CatFileInput {
  readonly ids: ReadonlyArray<ObjectId | string>;
  /** Per-object byte cap; forwarded to the underlying `readObject` call. */
  readonly maxBytes?: number;
}

export interface CatFileResult {
  readonly kind: 'batch';
  readonly entries: ReadonlyArray<CatFileBatchEntry>;
}

// `ObjectId` is a branded `string` at runtime, so both arms of the typeof
// resolve to a string-going-through-`ObjectId.from` shape; the conditional
// only exists to honor the typed input, not to gate runtime behavior.
const coerceId = (id: ObjectId | string): ObjectId =>
  // Stryker disable next-line ConditionalExpression: equivalent — see comment above.
  typeof id === 'string' ? ObjectId.from(id) : id;

export const catFile = async (ctx: Context, opts: CatFileInput): Promise<CatFileResult> => {
  await assertRepository(ctx);
  const ids = opts.ids.map(coerceId);
  const batchOptions: CatFileBatchOptions | undefined =
    opts.maxBytes === undefined ? undefined : { maxBytes: opts.maxBytes };
  const entries: CatFileBatchEntry[] = [];
  const stream =
    batchOptions === undefined ? catFileBatch(ctx, ids) : catFileBatch(ctx, ids, batchOptions);
  for await (const entry of stream) {
    entries.push(entry);
  }
  return { kind: 'batch', entries };
};
