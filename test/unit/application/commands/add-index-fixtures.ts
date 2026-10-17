import {
  invalidateIndexCache,
  readIndex,
} from '../../../../src/application/primitives/read-index.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import {
  type GitIndex,
  type IndexEntry,
  STAGE0_FLAGS,
} from '../../../../src/domain/git-index/index.js';
import { indexPathOfBytes } from '../../../../src/domain/git-index/index-path-key.js';
import { FILE_MODE, type FileMode } from '../../../../src/domain/objects/index.js';
import type { FilePath, ObjectId } from '../../../../src/domain/objects/object-id.js';
import type { Context } from '../../../../src/ports/context.js';
import { serializeIndexFixtureAsync } from '../primitives/fixtures.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** One index entry to seed: its path, the blob text it records, and the flags that matter. */
export interface IndexRow {
  readonly path: string | Uint8Array;
  readonly text: string;
  readonly stage?: 0 | 1 | 2 | 3;
  readonly mode?: FileMode;
  readonly skipWorktree?: boolean;
}

const pathFieldsOf = (path: string | Uint8Array): Pick<IndexEntry, 'path' | 'pathBytes'> => {
  if (typeof path === 'string') return { path: path as FilePath };
  const { path: decoded, pathBytes } = indexPathOfBytes(path);
  return pathBytes === undefined ? { path: decoded } : { path: decoded, pathBytes };
};

const entryOf = async (ctx: Context, row: IndexRow): Promise<IndexEntry> => ({
  ctimeSeconds: 0,
  ctimeNanoseconds: 0,
  mtimeSeconds: 0,
  mtimeNanoseconds: 0,
  dev: 0,
  ino: 0,
  mode: row.mode ?? FILE_MODE.REGULAR,
  uid: 0,
  gid: 0,
  fileSize: 0,
  id: await writeObject(ctx, { type: 'blob', id: '' as ObjectId, content: enc(row.text) }),
  flags: { ...STAGE0_FLAGS, stage: row.stage ?? 0, skipWorktree: row.skipWorktree ?? false },
  ...pathFieldsOf(row.path),
});

/** Replaces the index with `rows`; stat fields are zeroed so the stat shortcut never fires. */
export const seedIndex = async (ctx: Context, rows: ReadonlyArray<IndexRow>): Promise<void> => {
  const entries = await Promise.all(rows.map((row) => entryOf(ctx, row)));
  const version = rows.some((row) => row.skipWorktree === true) ? 3 : 2;
  const index: GitIndex = { version, entries, extensions: [], trailerSha: new Uint8Array(0) };
  invalidateIndexCache(ctx);
  await ctx.fs.write(`${ctx.layout.gitDir}/index`, await serializeIndexFixtureAsync(index, ctx));
};

/** `<path>@<stage>:<id>` for every entry the index holds, in index order. */
export const stagesOf = async (ctx: Context): Promise<string[]> => {
  invalidateIndexCache(ctx);
  const { entries } = await readIndex(ctx);
  return entries.map((entry) => `${entry.path}@${entry.flags.stage}:${entry.id}`);
};
