/**
 * git's `verify_filename` → `maybe_die_on_misspelt_object_name`: a revision
 * argument that named no object is read a second time, re-emitting every
 * warning its first read printed — unless the argument reads as a pathspec or
 * names a path that exists, which git takes as a filename instead.
 */
import { errorDataCode } from '../../../domain/error-data-code.js';
import { looksLikePathspec } from '../../../domain/pathspec/index.js';
import type { Context } from '../../../ports/context.js';
import { pathIsOccupied } from '../../primitives/internal/path-occupied.js';

/** The codes a read that found no object refuses with — git's `get_oid` returning -1. */
const UNRESOLVED_CODES: ReadonlySet<string | undefined> = new Set([
  'OBJECT_NOT_FOUND',
  'REVPARSE_UNRESOLVED',
  'PATH_NOT_IN_TREE',
]);

/** git's `is_missing_file_error`: `ENOENT` and `ENOTDIR` both mean nothing is there. */
const MISSING_FILE_CODES: ReadonlySet<string | undefined> = new Set([
  'FILE_NOT_FOUND',
  'NOT_A_DIRECTORY',
]);

const PARENT_SEGMENT = '..';

const namesExistingPath = async (ctx: Context, arg: string): Promise<boolean> => {
  // A parent hop is never probed: the adapters confine every path to the
  // repository, so such an argument cannot be told apart from an absent one.
  if (arg.split('/').includes(PARENT_SEGMENT)) return false;
  try {
    return await pathIsOccupied(ctx, `${ctx.layout.workDir ?? ctx.layout.gitDir}/${arg}`);
  } catch (error) {
    if (MISSING_FILE_CODES.has(errorDataCode(error))) return false;
    throw error;
  }
};

/** Whether `failure`, refusing `expression`, sends git back to read it once more. */
export const rereadsMisspeltRevision = async (
  ctx: Context,
  expression: string,
  failure: unknown,
): Promise<boolean> => {
  if (!UNRESOLVED_CODES.has(errorDataCode(failure))) return false;
  if (looksLikePathspec(expression)) return false;
  return !(await namesExistingPath(ctx, expression));
};
