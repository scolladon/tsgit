import { workingTreeFileTooLarge } from '../../../domain/commands/error.js';
import { indexMailmap, type MailmapIndex, parseMailmap } from '../../../domain/mailmap/index.js';
import { decode } from '../../../domain/objects/encoding.js';
import type { ObjectId } from '../../../domain/objects/index.js';
import { refCandidates } from '../../../domain/refs/index.js';
import type { Context } from '../../../ports/context.js';
import { readConfig } from '../config-read.js';
import { readBlob } from '../read-blob.js';
import { resolveRefOrMissing } from '../resolve-ref.js';
import { MAX_WORKING_TREE_BLOB_BYTES } from '../types.js';
import { joinPath } from './join-working-tree-path.js';
import { peel } from './peel.js';
import { expandUserPath, loadCappedUtf8 } from './read-capped-file.js';
import { findTreeEntry } from './resolve-tree-path.js';

const MAILMAP_FILE = '.mailmap';
const BARE_DEFAULT_BLOB = `HEAD:${MAILMAP_FILE}`;
const FULL_OID = /^[0-9a-f]+$/;

const readFileText = (ctx: Context, path: string): Promise<string | undefined> =>
  loadCappedUtf8(ctx, path, MAX_WORKING_TREE_BLOB_BYTES, workingTreeFileTooLarge);

const readWorktreeMailmap = async (ctx: Context): Promise<string | undefined> => {
  const workDir = ctx.layout.workDir;
  if (workDir === undefined) return undefined;
  return readFileText(ctx, joinPath(workDir, MAILMAP_FILE));
};

const resolveRevision = async (ctx: Context, rev: string): Promise<ObjectId | undefined> => {
  if (rev.length === ctx.hashConfig.hexLength && FULL_OID.test(rev)) return rev as ObjectId;
  for (const candidate of refCandidates(rev)) {
    const id = await resolveRefOrMissing(ctx, candidate);
    if (id !== undefined) return id;
  }
  return undefined;
};

/** `<rev>:<path>` as `get_oid_blob` reads it; `undefined` when it names nothing. */
const resolveBlobExpression = async (
  ctx: Context,
  expression: string,
): Promise<ObjectId | undefined> => {
  const colon = expression.indexOf(':');
  const rev = await resolveRevision(ctx, colon < 0 ? expression : expression.slice(0, colon));
  if (rev === undefined || colon < 0) return rev;
  const entry = await findTreeEntry(ctx, await peel(ctx, rev, 'tree'), expression.slice(colon + 1));
  return entry?.id;
};

const readBlobMailmap = async (ctx: Context, expression: string): Promise<string | undefined> => {
  const id = await resolveBlobExpression(ctx, expression);
  if (id === undefined) return undefined;
  return decode((await readBlob(ctx, id)).content);
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
  return ctx.layout.workDir === undefined ? BARE_DEFAULT_BLOB : undefined;
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
