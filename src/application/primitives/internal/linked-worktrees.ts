import { errorDataCode } from '../../../domain/error-data-code.js';
import type { Context } from '../../../ports/context.js';
import { commonGitDir } from '../path-layout.js';

/**
 * The open failures git's reflog and `gitdir` reads stop at without a word:
 * `files_for_each_reflog_ent` returns -1 when it cannot open the log, which every
 * caller discards, and `get_linked_worktree` skips a worktree whose `gitdir`
 * `strbuf_read_file` fails. Each reads as "no such file". Anything else — the
 * reflog size cap, an unclassified I/O fault — means the read never happened
 * and is rethrown.
 */
const UNOPENABLE_FILE_CODES: ReadonlySet<string> = new Set([
  'FILE_NOT_FOUND',
  'PERMISSION_DENIED',
  'NOT_A_DIRECTORY',
]);

export const isUnopenableFile = (err: unknown): boolean =>
  // Stryker disable next-line StringLiteral: equivalent — the fallback only types the lookup; no UNOPENABLE_FILE_CODES member is '' or any other literal, so every fallback misses alike.
  UNOPENABLE_FILE_CODES.has(errorDataCode(err) ?? '');

/** One `.git/worktrees/<id>` admin directory whose `gitdir` file git would list. */
export interface LinkedWorktreeAdmin {
  readonly id: string;
  readonly adminDir: string;
  /** The `gitdir` file's raw content, untrimmed. */
  readonly gitdirPointer: string;
}

const listAdminNames = async (ctx: Context, root: string): Promise<ReadonlyArray<string>> => {
  try {
    const entries = await (ctx.fs.readdirInOsOrder ?? ctx.fs.readdir).call(ctx.fs, root);
    return entries.map((entry) => entry.name);
  } catch (err) {
    if (errorDataCode(err) === 'FILE_NOT_FOUND') return [];
    throw err;
  }
};

const readAdmin = async (
  ctx: Context,
  root: string,
  id: string,
): Promise<LinkedWorktreeAdmin | undefined> => {
  const adminDir = `${root}/${id}`;
  try {
    const gitdirPointer = await ctx.fs.readUtf8(`${adminDir}/gitdir`);
    // git skips only a zero-byte file; one holding just whitespace still lists the worktree.
    return gitdirPointer === '' ? undefined : { id, adminDir, gitdirPointer };
  } catch (err) {
    if (isUnopenableFile(err)) return undefined;
    throw err;
  }
};

/**
 * git's `get_worktrees` order: every `.git/worktrees/*` entry as the OS lists it,
 * minus the ones whose `gitdir` file is missing, unreadable or empty.
 */
export async function linkedWorktreeAdmins(
  ctx: Context,
): Promise<ReadonlyArray<LinkedWorktreeAdmin>> {
  const root = `${commonGitDir(ctx)}/worktrees`;
  const admins: LinkedWorktreeAdmin[] = [];
  for (const id of await listAdminNames(ctx, root)) {
    const admin = await readAdmin(ctx, root, id);
    if (admin !== undefined) admins.push(admin);
  }
  return admins;
}
