/**
 * git's `verify_filename` → `maybe_die_on_misspelt_object_name`: a revision
 * argument that named no object is read a second time, re-emitting every
 * warning its first read printed — unless the argument reads as a pathspec or
 * names a path that exists, which git takes as a filename instead.
 *
 * An argument climbing with `..` is checked the way git's `lstat` sees it,
 * hops resolved by the operating system from the worktree (the git dir when
 * bare): the one read this probe makes outside the repository, through an
 * existence-only capability. Without that capability the path reads as absent.
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

const climbsWithParentHop = (arg: string): boolean => arg.split('/').includes(PARENT_SEGMENT);

const namesExistingPath = async (ctx: Context, arg: string): Promise<boolean> => {
  const path = `${ctx.layout.workDir ?? ctx.layout.gitDir}/${arg}`;
  if (climbsWithParentHop(arg)) return (await ctx.filenameProbe?.(path)) ?? false;
  try {
    return await pathIsOccupied(ctx, path);
  } catch (error) {
    if (MISSING_FILE_CODES.has(errorDataCode(error))) return false;
    throw error;
  }
};

/** Whether `failure` is git's `get_oid` returning -1: the read named no object, and nothing died. */
export const namesNoObject = (failure: unknown): boolean =>
  UNRESOLVED_CODES.has(errorDataCode(failure));

/** Whether `failure`, refusing `expression`, sends git back to read it once more. */
export const rereadsMisspeltRevision = async (
  ctx: Context,
  expression: string,
  failure: unknown,
): Promise<boolean> => {
  if (!namesNoObject(failure)) return false;
  if (looksLikePathspec(expression)) return false;
  return !(await namesExistingPath(ctx, expression));
};
