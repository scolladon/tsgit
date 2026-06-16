/**
 * Tier-1 `readFileAt` command — read a file's bytes as of a revision, the
 * structured equivalent of `git show <rev>:<path>` / `git cat-file blob
 * <rev>:<path>`.
 *
 * Resolves `rev` through the full rev-parse grammar (short names, `~`/`^`
 * navigation, abbreviated oids, reflog selectors), peels to its root tree,
 * descends `path`'s `/`-separated components, and returns the addressed blob —
 * refusing a directory or gitlink with `UNEXPECTED_OBJECT_TYPE` and a missing
 * path with `PATH_NOT_IN_TREE`. The library renders nothing; the caller owns any
 * display.
 */
import type { FileMode, ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { descendTreePath } from '../primitives/internal/resolve-tree-path.js';
import { readBlob } from '../primitives/read-blob.js';
import { readTree } from '../primitives/read-tree.js';
import type { ReadObjectOptions } from '../primitives/types.js';
import { assertRepository } from './internal/repo-state.js';
import { assertNoValuelessCoreConfig } from './internal/valueless-config-guard.js';
import { revParse } from './rev-parse.js';

/** Structured result of reading a file's bytes as of a revision. */
export interface ReadFileAtResult {
  /** The addressed blob's object id. */
  readonly id: ObjectId;
  /** The file's tree-entry mode (`100644` | `100755` | `120000`). */
  readonly mode: FileMode;
  /** The blob's raw, verbatim committed bytes. */
  readonly content: Uint8Array;
}

/**
 * Read the file addressed by `path` in the tree of `rev`.
 *
 * @param rev - any rev-parse expression (e.g. `HEAD`, `main`, `v1.0`, `HEAD~3`,
 *   an abbreviated oid).
 * @param path - a `/`-separated tree path to the file.
 * @param options - forwarded to the final blob read; `maxBytes` bounds the file
 *   (`OBJECT_TOO_LARGE` when exceeded), `verifyHash` re-checks its hash.
 */
export const readFileAt = async (
  ctx: Context,
  rev: string,
  path: string,
  options?: ReadObjectOptions,
): Promise<ReadFileAtResult> => {
  await assertRepository(ctx);
  await assertNoValuelessCoreConfig(ctx);
  const revOid = await revParse(ctx, rev);
  const rootTree = await readTree(ctx, revOid);
  const entry = await descendTreePath(ctx, rootTree, path, rev);
  const blob = await readBlob(ctx, entry.id, options);
  return { id: entry.id, mode: entry.mode, content: blob.content };
};
