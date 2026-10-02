/** Builders for fsck typing-order suites: objects, ids and fanout read order. */
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import type { FsckFinding } from '../../../../src/application/commands/fsck.js';
import { looseObjectPath, objectsDir } from '../../../../src/application/primitives/path-layout.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { FILE_MODE, type FileMode } from '../../../../src/domain/objects/file-mode.js';
import type { GitObject, ObjectId, ObjectType } from '../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../src/domain/objects/tree.js';
import type { Context } from '../../../../src/ports/context.js';

export const IDENT = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};
export const ENCODER = new TextEncoder();
export const SEARCH_LIMIT = 4096;

export const blobOf = (text: string): GitObject => ({
  type: 'blob',
  id: '' as ObjectId,
  content: ENCODER.encode(text),
});

export const commitOf = (
  tree: ObjectId,
  parents: ReadonlyArray<ObjectId>,
  message: string,
): GitObject => ({
  type: 'commit',
  id: '' as ObjectId,
  data: { tree, parents, author: IDENT, committer: IDENT, message, extraHeaders: [] },
});

export const tagOf = (object: ObjectId, objectType: ObjectType, message: string): GitObject => ({
  type: 'tag',
  id: '' as ObjectId,
  data: { object, objectType, tagName: 'v', tagger: IDENT, message, extraHeaders: [] },
});

export const treeOf = (mode: FileMode, name: string, id: ObjectId): GitObject => ({
  type: 'tree',
  id: '' as ObjectId,
  entries: [treeEntry(mode, name, id)],
});

/** The id `object` would get, without writing it where the audit reads. */
export const idOf = (object: GitObject): Promise<ObjectId> =>
  writeObject(createMemoryContext(), object);

/** Whether fsck's loose read meets `first` before `second`: an earlier fanout directory. */
export const readBefore = (first: ObjectId, second: ObjectId): boolean =>
  first.slice(0, 2) < second.slice(0, 2);

/** The first object `build(n)` makes whose id satisfies `accept`. */
export const searchFor = async (
  build: (n: number) => GitObject,
  accept: (id: ObjectId) => boolean,
): Promise<GitObject> => {
  for (let n = 0; n < SEARCH_LIMIT; n++) {
    const object = build(n);
    if (accept(await idOf(object))) return object;
  }
  throw new Error('no object satisfies the read order');
};

/** A loose commit stored byte for byte, the first whose id `fsck` reads after `after`. */
export const plantRawCommitAfter = async (
  ctx: Context,
  after: ObjectId,
  header: string,
): Promise<ObjectId> => {
  for (let n = 0; n < SEARCH_LIMIT; n++) {
    const body = ENCODER.encode(`${header}\nm${n}\n`);
    const raw = new Uint8Array([...ENCODER.encode(`commit ${body.length}\0`), ...body]);
    const id = (await ctx.hash.hashHex(raw)) as ObjectId;
    if (!readBefore(after, id)) continue;
    await ctx.fs.mkdir(objectsDir(ctx.layout.gitDir, id.slice(0, 2)));
    await ctx.fs.write(looseObjectPath(ctx.layout.gitDir, id), await ctx.compressor.deflate(raw));
    return id;
  }
  throw new Error('no commit satisfies the read order');
};

export const emptyRepo = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  return ctx;
};

export const pointRef = (ctx: Context, ref: string, id: ObjectId): Promise<void> =>
  ctx.fs.writeUtf8(`${ctx.layout.gitDir}/${ref}`, `${id}\n`);

/** A base commit on main, so the objects under test are the only unreferenced ones. */
export const repoWithMain = async (): Promise<Context> => {
  const ctx = await emptyRepo();
  const base = await writeObject(ctx, blobOf('base\n'));
  const tree = await writeObject(ctx, treeOf(FILE_MODE.REGULAR, 'base', base));
  await pointRef(ctx, 'refs/heads/main', await writeObject(ctx, commitOf(tree, [], 'base')));
  return ctx;
};

export const findingsOfType = <T extends FsckFinding['type']>(
  findings: ReadonlyArray<FsckFinding>,
  type: T,
): ReadonlyArray<Extract<FsckFinding, { type: T }>> =>
  findings.filter((finding): finding is Extract<FsckFinding, { type: T }> => finding.type === type);

export const aboutId = (findings: ReadonlyArray<FsckFinding>, id: ObjectId) =>
  findings.filter((finding) => 'id' in finding && finding.id === id);
