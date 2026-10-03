import { workingTreeFileTooLarge } from '../../../domain/commands/error.js';
import { errorDataCode } from '../../../domain/error-data-code.js';
import { indexMailmap, type MailmapIndex, parseMailmap } from '../../../domain/mailmap/index.js';
import { decode } from '../../../domain/objects/encoding.js';
import type { GitObject, ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { readConfig } from '../../primitives/config-read.js';
import { joinPath } from '../../primitives/internal/join-working-tree-path.js';
import { expandUserPath, loadCappedUtf8 } from '../../primitives/internal/read-capped-file.js';
import { readObject } from '../../primitives/read-object.js';
import { MAX_WORKING_TREE_BLOB_BYTES } from '../../primitives/types.js';
import { evaluateRevision } from '../rev-parse.js';
import { reportAmbiguousOid } from './ambiguous-oid-report.js';

const MAILMAP_FILE = '.mailmap';
const BARE_DEFAULT_BLOB = `HEAD:${MAILMAP_FILE}`;

const readFileText = (ctx: Context, path: string): Promise<string | undefined> =>
  loadCappedUtf8(ctx, path, MAX_WORKING_TREE_BLOB_BYTES, workingTreeFileTooLarge);

const readWorktreeMailmap = async (ctx: Context): Promise<string | undefined> => {
  const workDir = ctx.layout.workDir;
  if (ctx.layout.bare || workDir === undefined) return undefined;
  return readFileText(ctx, joinPath(workDir, MAILMAP_FILE));
};

/** The codes `get_oid` answers -1 with: the expression names no object, so no blob is read. */
const UNRESOLVED_CODES: ReadonlySet<string | undefined> = new Set([
  'OBJECT_NOT_FOUND',
  'REVPARSE_UNRESOLVED',
  'PATH_NOT_IN_TREE',
  'AMBIGUOUS_OID_PREFIX',
]);

/** `mailmap.blob` as `read_mailmap_blob`'s `repo_get_oid` reads it; `undefined` when it names nothing. */
const resolveBlobExpression = async (
  ctx: Context,
  expression: string,
): Promise<ObjectId | undefined> => {
  try {
    return await evaluateRevision(ctx, expression);
  } catch (error) {
    if (!UNRESOLVED_CODES.has(errorDataCode(error))) throw error;
    reportAmbiguousOid(ctx, error);
    return undefined;
  }
};

/** `odb_read_object`: an id `get_oid` accepted whose object is absent is reported, not refused. */
const readNamedObject = async (
  ctx: Context,
  id: ObjectId,
  expression: string,
): Promise<GitObject | undefined> => {
  try {
    return await readObject(ctx, id);
  } catch (error) {
    if (errorDataCode(error) !== 'OBJECT_NOT_FOUND') throw error;
    ctx.logger?.error?.(`unable to read mailmap object at ${expression}`, { expression });
    return undefined;
  }
};

/** git reports a named object that is no blob and reads the mailmap on without it. */
const readBlobMailmap = async (ctx: Context, expression: string): Promise<string | undefined> => {
  const id = await resolveBlobExpression(ctx, expression);
  if (id === undefined) return undefined;
  const object = await readNamedObject(ctx, id, expression);
  if (object === undefined) return undefined;
  if (object.type === 'blob') return decode(object.content);
  ctx.logger?.error?.(`mailmap is not a blob: ${expression}`, { expression });
  return undefined;
};

const readConfiguredFile = async (ctx: Context, raw: string): Promise<string | undefined> => {
  const expanded = expandUserPath(ctx, raw);
  if (expanded === undefined) return undefined;
  const workDir = ctx.layout.workDir;
  const absolute =
    workDir === undefined || expanded.startsWith('/') ? expanded : joinPath(workDir, expanded);
  return readFileText(ctx, absolute);
};

const blobExpression = (ctx: Context, configured: string | undefined): string | undefined => {
  if (configured !== undefined) return configured;
  return ctx.layout.bare ? BARE_DEFAULT_BLOB : undefined;
};

/**
 * `read_mailmap`: the worktree `.mailmap`, then `mailmap.blob` (`HEAD:.mailmap` in a bare
 * repository), then `mailmap.file` — later rules override earlier ones. The archived tree's
 * own `.mailmap` is never a source.
 */
export const readMailmap = async (ctx: Context): Promise<MailmapIndex> => {
  const { mailmap } = await readConfig(ctx);
  const expression = blobExpression(ctx, mailmap?.blob);
  const texts = [
    await readWorktreeMailmap(ctx),
    expression === undefined ? undefined : await readBlobMailmap(ctx, expression),
    mailmap?.file === undefined ? undefined : await readConfiguredFile(ctx, mailmap.file),
  ];
  return indexMailmap(texts.flatMap((text) => (text === undefined ? [] : parseMailmap(text))));
};
