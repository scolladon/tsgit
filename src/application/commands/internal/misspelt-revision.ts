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
import { isMessageSearch } from './rev-parse-grammar.js';
import { startupPrefix } from './startup-prefix.js';

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
/** `check_filename`'s magic: `:/` reads from the worktree top, `:!` and `:^` exclude. */
const TOP_MAGIC = ':/';
const EXCLUDE_MAGICS: ReadonlyArray<string> = [':!', ':^'];

interface FilenameSpelling {
  readonly rest: string;
  readonly magic: boolean;
  readonly fromTop: boolean;
}

const climbsWithParentHop = (arg: string): boolean => arg.split('/').includes(PARENT_SEGMENT);

const namesExistingPath = async (ctx: Context, relative: string): Promise<boolean> => {
  const path = `${ctx.layout.workDir ?? ctx.layout.gitDir}/${relative}`;
  if (climbsWithParentHop(relative)) return (await ctx.filenameProbe?.(path)) ?? false;
  try {
    return await pathIsOccupied(ctx, path);
  } catch (error) {
    if (MISSING_FILE_CODES.has(errorDataCode(error))) return false;
    throw error;
  }
};

const spellingOf = (arg: string): FilenameSpelling => {
  if (arg.startsWith(TOP_MAGIC)) {
    return { rest: arg.slice(TOP_MAGIC.length), magic: true, fromTop: true };
  }
  const exclude = EXCLUDE_MAGICS.find((magic) => arg.startsWith(magic));
  if (exclude === undefined) return { rest: arg, magic: false, fromTop: false };
  return { rest: arg.slice(exclude.length), magic: true, fromTop: false };
};

/**
 * git's `check_filename`: whether `arg` names an existing path, taken against
 * the caller's directory unless spelt `:/` from the top; a bare magic prefix
 * always does, and an empty name at the top never does.
 */
const checkFilename = async (ctx: Context, arg: string): Promise<boolean> => {
  const { rest, magic, fromTop } = spellingOf(arg);
  if (magic && rest === '') return true;
  const prefix = fromTop ? '' : (startupPrefix(ctx.cwd, ctx.layout.workDir) ?? '');
  const relative = `${prefix}${rest}`;
  if (relative === '') return false;
  return namesExistingPath(ctx, relative);
};

/** git's `verify_filename` passing: `arg` reads as a pathspec or names an existing path. */
export const namesFilename = async (ctx: Context, arg: string): Promise<boolean> =>
  looksLikePathspec(arg) || (await checkFilename(ctx, arg));

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
  // git's second read (`GET_OID_ONLY_TO_DIE`) skips a `:/` search, so nothing it printed repeats.
  if (isMessageSearch(expression)) return false;
  return !(await namesFilename(ctx, expression));
};
