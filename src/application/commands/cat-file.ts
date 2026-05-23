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
import type { CatFileBatchEntry } from '../primitives/types.js';
import { assertRepository } from './internal/repo-state.js';

export type { CatFileBatchEntry };

export interface CatFileInput {
  readonly action?: 'batch';
  readonly ids: ReadonlyArray<ObjectId | string>;
}

export interface CatFileResult {
  readonly kind: 'batch';
  readonly entries: ReadonlyArray<CatFileBatchEntry>;
}

const coerceId = (id: ObjectId | string): ObjectId =>
  typeof id === 'string' ? ObjectId.from(id) : id;

export const catFile = async (ctx: Context, opts: CatFileInput): Promise<CatFileResult> => {
  await assertRepository(ctx);
  const ids = opts.ids.map(coerceId);
  const entries: CatFileBatchEntry[] = [];
  for await (const entry of catFileBatch(ctx, ids)) {
    entries.push(entry);
  }
  return { kind: 'batch', entries };
};
