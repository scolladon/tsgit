/**
 * Git-byte-faithful `.git/sequencer/` state for a multi-pick `cherry-pick`
 * (and, later, `revert`/`rebase`). Files match real git exactly:
 *
 * - `head`         — pre-sequence HEAD `<oid>\n` (abort target; immutable).
 * - `todo`         — `pick <oid> <subject>\n` lines; line 0 is the current/next
 *                    instruction. Written with **full** oids; reads resolve git's
 *                    abbreviated oids via `resolveOidPrefix`.
 * - `abort-safety` — current HEAD `<oid>\n` (advances per completed pick).
 * - `opts`         — git-config `[options]` with non-default keys only.
 *
 * Verified against git: no `done` file, no `opts` file when all options default,
 * no sequencer dir at all for a single-commit pick.
 */
import { invalidSequencerTodo } from '../../../domain/commands/error.js';
import type { ObjectId } from '../../../domain/objects/index.js';
import { parseTodo, serializeTodo, type TodoEntry } from '../../../domain/sequencer/index.js';
import type { Context } from '../../../ports/context.js';
import { parseIniSections } from '../../primitives/config-read.js';
import { resolveOidPrefix } from '../../primitives/resolve-oid-prefix.js';
import { readOptionalOidFile } from './oid-file.js';

export interface SequencerOpts {
  readonly recordOrigin: boolean;
  readonly allowEmpty: boolean;
  readonly noCommit: boolean;
}

export interface ResolvedTodoEntry {
  readonly command: 'pick';
  readonly oid: ObjectId;
  readonly subject: string;
}

const seqDir = (ctx: Context): string => `${ctx.layout.gitDir}/sequencer`;
const headPath = (ctx: Context): string => `${seqDir(ctx)}/head`;
const todoPath = (ctx: Context): string => `${seqDir(ctx)}/todo`;
const abortSafetyPath = (ctx: Context): string => `${seqDir(ctx)}/abort-safety`;
const optsPath = (ctx: Context): string => `${seqDir(ctx)}/opts`;

export const writeSequencerHead = (ctx: Context, headId: ObjectId): Promise<void> =>
  ctx.fs.writeUtf8(headPath(ctx), `${headId}\n`);

export const readSequencerHead = (ctx: Context): Promise<ObjectId | undefined> =>
  readOptionalOidFile(ctx, headPath(ctx));

export const writeAbortSafety = (ctx: Context, headId: ObjectId): Promise<void> =>
  ctx.fs.writeUtf8(abortSafetyPath(ctx), `${headId}\n`);

export const readAbortSafety = (ctx: Context): Promise<ObjectId | undefined> =>
  readOptionalOidFile(ctx, abortSafetyPath(ctx));

/** Write the todo work-list. Callers pass full oids; git re-resolves either way. */
export const writeSequencerTodo = (
  ctx: Context,
  entries: ReadonlyArray<TodoEntry>,
): Promise<void> => ctx.fs.writeUtf8(todoPath(ctx), serializeTodo(entries));

/**
 * Read the todo, resolving each (possibly abbreviated) oid to a full ObjectId.
 * Returns `undefined` when absent. A line referencing an unresolvable oid is a
 * corrupt todo → `INVALID_SEQUENCER_TODO`.
 */
export const readSequencerTodo = async (
  ctx: Context,
): Promise<ReadonlyArray<ResolvedTodoEntry> | undefined> => {
  const path = todoPath(ctx);
  if (!(await ctx.fs.exists(path))) return undefined;
  const parsed = parseTodo(await ctx.fs.readUtf8(path));
  const resolved: ResolvedTodoEntry[] = [];
  for (const entry of parsed) {
    const oid = await resolveOidPrefix(ctx, entry.oid);
    if (oid === undefined) throw invalidSequencerTodo(`cannot resolve commit ${entry.oid}`);
    resolved.push({ command: 'pick', oid, subject: entry.subject });
  }
  return resolved;
};

/** git's `save_opts` order: `no-commit`, `record-origin`, `allow-empty`. */
const serializeOpts = (opts: SequencerOpts): string => {
  let body = '[options]\n';
  if (opts.noCommit) body += '\tno-commit = true\n';
  if (opts.recordOrigin) body += '\trecord-origin = true\n';
  if (opts.allowEmpty) body += '\tallow-empty = true\n';
  return body;
};

/** Write `opts` only when at least one option is non-default (matches git). */
export const writeSequencerOpts = async (ctx: Context, opts: SequencerOpts): Promise<void> => {
  if (!opts.noCommit && !opts.recordOrigin && !opts.allowEmpty) return;
  await ctx.fs.writeUtf8(optsPath(ctx), serializeOpts(opts));
};

const hasTrueKey = (sections: ReturnType<typeof parseIniSections>, key: string): boolean =>
  sections.some(
    (s) =>
      s.section.toLowerCase() === 'options' &&
      s.entries.some((e) => e.key.toLowerCase() === key && e.value.toLowerCase() === 'true'),
  );

export const readSequencerOpts = async (ctx: Context): Promise<SequencerOpts> => {
  const path = optsPath(ctx);
  if (!(await ctx.fs.exists(path))) {
    return { recordOrigin: false, allowEmpty: false, noCommit: false };
  }
  const sections = parseIniSections(await ctx.fs.readUtf8(path));
  return {
    noCommit: hasTrueKey(sections, 'no-commit'),
    recordOrigin: hasTrueKey(sections, 'record-origin'),
    allowEmpty: hasTrueKey(sections, 'allow-empty'),
  };
};

/** Remove the whole `.git/sequencer/` directory. Idempotent. */
export const clearSequencer = async (ctx: Context): Promise<void> => {
  const dir = seqDir(ctx);
  // equivalent-mutant: `rmRecursive` is itself a no-op on an absent path (proven by
  // the "directory is absent → no-op" test), so the existence guard is a pure
  // optimisation — removing it leaves the observable result unchanged.
  if (await ctx.fs.exists(dir)) {
    await ctx.fs.rmRecursive(dir);
  }
};
