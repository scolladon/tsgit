/**
 * Git-byte-faithful `.git/rebase-merge/` state for a non-interactive `rebase`
 * (the merge backend). Every file the backend writes is reproduced exactly so a
 * tsgit-stopped rebase is resumable by `git rebase --continue` and vice-versa
 * (ADR-229). `.git/REBASE_HEAD` (the marker `assertNoPendingOperation` reads) is
 * written alongside.
 *
 * Files: `head-name` (`refs/heads/<b>` | `detached HEAD`), `onto`, `orig-head`,
 * `git-rebase-todo` (remaining) + `git-rebase-todo.backup`, `done`, `message`,
 * `author-script`, `end`, `msgnum`, `interactive` (empty), `rewritten-list`,
 * `patch`, `drop_redundant_commits`/`no-reschedule-failed-exec` (empty),
 * `stopped-sha`.
 */

import { invalidSequencerTodo } from '../../../domain/commands/error.js';
import type { ObjectId } from '../../../domain/objects/index.js';
import {
  type AuthorIdentity,
  parseAuthorScript,
  parseRebaseTodo,
  type RebaseBackupHeader,
  type RebaseTodoEntry,
  rebaseTodoBackup,
  serializeAuthorScript,
  serializeRebaseTodo,
} from '../../../domain/rebase/index.js';
import type { Context } from '../../../ports/context.js';
import { resolveOidPrefix } from '../../primitives/resolve-oid-prefix.js';
import { readOptionalOidFile } from './oid-file.js';

/** A todo/done entry with its oid resolved to a full ObjectId. */
export interface ResolvedRebaseTodoEntry {
  readonly oid: ObjectId;
  readonly subject: string;
}

/** Everything `writeRebaseStop` persists for one conflict stop. */
export interface RebaseStop {
  readonly headName: string;
  readonly onto: ObjectId;
  readonly origHead: ObjectId;
  /** Completed instructions, including the stopped one (last). */
  readonly done: ReadonlyArray<RebaseTodoEntry>;
  /** Instructions still to apply (the live `git-rebase-todo`). */
  readonly remaining: ReadonlyArray<RebaseTodoEntry>;
  readonly stoppedSha: ObjectId;
  readonly stoppedAuthor: AuthorIdentity;
  readonly message: string;
  /** `old new` oid pairs for the picks that committed cleanly before the stop. */
  readonly rewritten: ReadonlyArray<readonly [ObjectId, ObjectId]>;
  readonly patch: string;
  readonly backupHeader: RebaseBackupHeader;
}

/** The aggregated read used by `continue` / `skip` / `abort`. */
export interface RebaseState {
  readonly headName: string;
  readonly onto: ObjectId;
  readonly origHead: ObjectId;
  readonly done: ReadonlyArray<ResolvedRebaseTodoEntry>;
  readonly remaining: ReadonlyArray<ResolvedRebaseTodoEntry>;
  readonly stoppedSha: ObjectId | undefined;
  readonly author: AuthorIdentity;
  readonly message: string;
}

const dir = (ctx: Context): string => `${ctx.layout.gitDir}/rebase-merge`;
const file = (ctx: Context, name: string): string => `${dir(ctx)}/${name}`;
const rebaseHeadPath = (ctx: Context): string => `${ctx.layout.gitDir}/REBASE_HEAD`;

const serializeRewritten = (pairs: ReadonlyArray<readonly [ObjectId, ObjectId]>): string =>
  pairs.map(([oldId, newId]) => `${oldId} ${newId}\n`).join('');

export const writeRebaseStop = async (ctx: Context, stop: RebaseStop): Promise<void> => {
  const fullTodo = [...stop.done, ...stop.remaining];
  const write = (name: string, body: string): Promise<void> =>
    ctx.fs.writeUtf8(file(ctx, name), body);
  await write('head-name', `${stop.headName}\n`);
  await write('onto', `${stop.onto}\n`);
  await write('orig-head', `${stop.origHead}\n`);
  await write('git-rebase-todo', serializeRebaseTodo(stop.remaining));
  await write('git-rebase-todo.backup', rebaseTodoBackup(fullTodo, stop.backupHeader));
  await write('done', serializeRebaseTodo(stop.done));
  await write('message', stop.message);
  await write('author-script', serializeAuthorScript(stop.stoppedAuthor));
  await write('end', `${fullTodo.length}\n`);
  await write('msgnum', `${stop.done.length}\n`);
  await write('interactive', '');
  await write('rewritten-list', serializeRewritten(stop.rewritten));
  await write('patch', stop.patch);
  await write('drop_redundant_commits', '');
  await write('no-reschedule-failed-exec', '');
  await write('stopped-sha', `${stop.stoppedSha}\n`);
  await ctx.fs.writeUtf8(rebaseHeadPath(ctx), `${stop.stoppedSha}\n`);
};

export const readRebaseHead = (ctx: Context): Promise<ObjectId | undefined> =>
  readOptionalOidFile(ctx, rebaseHeadPath(ctx));

export const rebaseInProgress = (ctx: Context): Promise<boolean> => ctx.fs.exists(dir(ctx));

/** Resolve each parsed todo entry's (possibly abbreviated) oid to a full ObjectId. */
const resolveEntries = async (
  ctx: Context,
  entries: ReadonlyArray<RebaseTodoEntry>,
): Promise<ReadonlyArray<ResolvedRebaseTodoEntry>> => {
  const resolved: ResolvedRebaseTodoEntry[] = [];
  for (const entry of entries) {
    const oid = await resolveOidPrefix(ctx, entry.oid);
    if (oid === undefined) throw invalidSequencerTodo(`cannot resolve commit ${entry.oid}`);
    resolved.push({ oid, subject: entry.subject });
  }
  return resolved;
};

export const readRebaseState = async (ctx: Context): Promise<RebaseState | undefined> => {
  if (!(await rebaseInProgress(ctx))) return undefined;
  const headName = (await ctx.fs.readUtf8(file(ctx, 'head-name'))).trimEnd();
  const onto = (await readOptionalOidFile(ctx, file(ctx, 'onto'))) as ObjectId;
  const origHead = (await readOptionalOidFile(ctx, file(ctx, 'orig-head'))) as ObjectId;
  const done = await resolveEntries(ctx, parseRebaseTodo(await ctx.fs.readUtf8(file(ctx, 'done'))));
  const remaining = await resolveEntries(
    ctx,
    parseRebaseTodo(await ctx.fs.readUtf8(file(ctx, 'git-rebase-todo'))),
  );
  const author = parseAuthorScript(await ctx.fs.readUtf8(file(ctx, 'author-script')));
  const message = await ctx.fs.readUtf8(file(ctx, 'message'));
  return {
    headName,
    onto,
    origHead,
    done,
    remaining,
    stoppedSha: await readRebaseHead(ctx),
    author,
    message,
  };
};

/** Remove the whole `.git/rebase-merge/` dir and `.git/REBASE_HEAD`. Idempotent. */
export const clearRebaseState = async (ctx: Context): Promise<void> => {
  if (await ctx.fs.exists(dir(ctx))) await ctx.fs.rmRecursive(dir(ctx));
  if (await ctx.fs.exists(rebaseHeadPath(ctx))) await ctx.fs.rm(rebaseHeadPath(ctx));
};
