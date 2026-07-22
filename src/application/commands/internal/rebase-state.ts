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
  type RebaseTodoAction,
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
  readonly action: RebaseTodoAction;
  readonly oid: ObjectId;
  readonly subject: string;
}

/** One melded member of an in-flight squash/fixup group (`current-fixups`). */
export interface CurrentFixup {
  readonly action: 'squash' | 'fixup';
  readonly oid: ObjectId;
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
  /** Header for `git-rebase-todo.backup`. Set on the initial stop only — git
   *  writes the backup once and never rewrites it, so `continue`/`skip` re-stops
   *  omit it and leave the existing file untouched. */
  readonly backupHeader?: RebaseBackupHeader;
  /** The commit being amended — set on an `edit` stop (and a squash/fixup meld).
   *  Its presence is the marker that distinguishes an `edit` stop (clean index)
   *  from a conflict stop on `continue`. */
  readonly amend?: ObjectId;
  /** In-flight squash/fixup group members (`current-fixups`), in meld order. */
  readonly currentFixups?: ReadonlyArray<CurrentFixup>;
  /** Original oids already folded into the running squashed commit
   *  (`rewritten-pending`) — each maps to the final oid when the group ends. */
  readonly rewrittenPending?: ReadonlyArray<ObjectId>;
  /** Backup of the running combined message (`message-squash`). */
  readonly messageSquash?: string;
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
  /** The `amend` marker (edit stop / squash meld), or `undefined` for a plain
   *  conflict stop — the signal `continue` reads to choose amend-or-skip. */
  readonly amend?: ObjectId;
  /** In-flight squash/fixup group members, or `undefined` when not mid-group. */
  readonly currentFixups?: ReadonlyArray<CurrentFixup>;
  /** Original oids already folded into the running squashed commit. */
  readonly rewrittenPending?: ReadonlyArray<ObjectId>;
}

const dir = (ctx: Context): string => `${ctx.layout.gitDir}/rebase-merge`;
const file = (ctx: Context, name: string): string => `${dir(ctx)}/${name}`;
const rebaseHeadPath = (ctx: Context): string => `${ctx.layout.gitDir}/REBASE_HEAD`;

/**
 * Serialise rewritten `[old, new]` pairs to git's `<old> SP <new> LF` lines —
 * the exact byte format of both the `.git/rebase-merge/rewritten-list` file and
 * the stdin canonical git feeds the `post-rewrite` hook.
 */
export const serializeRewritten = (pairs: ReadonlyArray<readonly [ObjectId, ObjectId]>): string =>
  pairs.map(([oldId, newId]) => `${oldId} ${newId}\n`).join('');

export const writeRebaseStop = async (ctx: Context, stop: RebaseStop): Promise<void> => {
  const fullTodo = [...stop.done, ...stop.remaining];
  const write = (name: string, body: string): Promise<void> =>
    ctx.fs.writeUtf8(file(ctx, name), body);
  await write('head-name', `${stop.headName}\n`);
  await write('onto', `${stop.onto}\n`);
  await write('orig-head', `${stop.origHead}\n`);
  await write('git-rebase-todo', serializeRebaseTodo(stop.remaining));
  if (stop.backupHeader !== undefined) {
    await write('git-rebase-todo.backup', rebaseTodoBackup(fullTodo, stop.backupHeader));
  }
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
  if (stop.amend !== undefined) await write('amend', `${stop.amend}\n`);
  if (stop.currentFixups !== undefined) {
    await write('current-fixups', stop.currentFixups.map((f) => `${f.action} ${f.oid}\n`).join(''));
  }
  if (stop.rewrittenPending !== undefined) {
    await write('rewritten-pending', stop.rewrittenPending.map((oid) => `${oid}\n`).join(''));
  }
  if (stop.messageSquash !== undefined) await write('message-squash', stop.messageSquash);
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
    resolved.push({ action: entry.action, oid, subject: entry.subject });
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
  const amend = await readOptionalOidFile(ctx, file(ctx, 'amend'));
  const currentFixups = await readCurrentFixups(ctx);
  const rewrittenPending = await readRewrittenPending(ctx);
  return {
    headName,
    onto,
    origHead,
    done,
    remaining,
    stoppedSha: await readRebaseHead(ctx),
    author,
    message,
    ...(amend !== undefined ? { amend } : {}),
    ...(currentFixups !== undefined ? { currentFixups } : {}),
    ...(rewrittenPending !== undefined ? { rewrittenPending } : {}),
  };
};

/** Parse `current-fixups` (`<verb> <oid>` lines), or `undefined` when absent. */
const readCurrentFixups = async (
  ctx: Context,
): Promise<ReadonlyArray<CurrentFixup> | undefined> => {
  const path = file(ctx, 'current-fixups');
  if (!(await ctx.fs.exists(path))) return undefined;
  const fixups: CurrentFixup[] = [];
  for (const line of (await ctx.fs.readUtf8(path)).split('\n')) {
    const [action, oid] = line.split(' ');
    if ((action === 'squash' || action === 'fixup') && oid !== undefined) {
      fixups.push({ action, oid: oid as ObjectId });
    }
  }
  return fixups;
};

/** Parse `rewritten-pending` (`<oid>` lines), or `undefined` when absent. */
const readRewrittenPending = async (ctx: Context): Promise<ReadonlyArray<ObjectId> | undefined> => {
  const path = file(ctx, 'rewritten-pending');
  if (!(await ctx.fs.exists(path))) return undefined;
  const oids: ObjectId[] = [];
  for (const line of (await ctx.fs.readUtf8(path)).split('\n')) {
    if (line !== '') oids.push(line as ObjectId);
  }
  return oids;
};

/** Read the accumulated `rewritten-list` old→new pairs (for carry-forward across
 *  a `continue`/`skip` re-stop). Empty when absent. */
export const readRewrittenList = async (
  ctx: Context,
): Promise<ReadonlyArray<readonly [ObjectId, ObjectId]>> => {
  const path = file(ctx, 'rewritten-list');
  if (!(await ctx.fs.exists(path))) return [];
  const pairs: Array<readonly [ObjectId, ObjectId]> = [];
  for (const line of (await ctx.fs.readUtf8(path)).split('\n')) {
    const [oldId, newId] = line.split(' ');
    if (oldId !== undefined && newId !== undefined) {
      pairs.push([oldId as ObjectId, newId as ObjectId]);
    }
  }
  return pairs;
};

/** Remove the whole `.git/rebase-merge/` dir and `.git/REBASE_HEAD`. Idempotent. */
export const clearRebaseState = async (ctx: Context): Promise<void> => {
  if (await ctx.fs.exists(dir(ctx))) await ctx.fs.rmRecursive(dir(ctx));
  if (await ctx.fs.exists(rebaseHeadPath(ctx))) await ctx.fs.rm(rebaseHeadPath(ctx));
};
