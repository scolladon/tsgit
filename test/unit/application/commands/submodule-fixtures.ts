import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { deriveGitlinkContext } from '../../../../src/application/primitives/internal/submodule-context.js';
import {
  invalidateIndexCache,
  readIndex,
} from '../../../../src/application/primitives/read-index.js';
import type { AuthorIdentity, FilePath, ObjectId } from '../../../../src/domain/objects/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { serializeIndexFixtureAsync } from '../primitives/fixtures.js';
import { seedIndex } from './add-index-fixtures.js';

export const SUBMODULE_AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

export const workPath = (ctx: Context, name: string): string => `${ctx.layout.workDir}/${name}`;

export interface SubmoduleFixture {
  readonly ctx: Context;
  readonly child: Context;
}

const TRACKED_K = [{ path: 'k', text: 'k\n' }];

/** Record `id` as the gitlink at `path` in an index that also tracks `beside` (`k` by default), then commit it; the commit's id. */
export const recordGitlink = async (
  ctx: Context,
  path: string,
  id: ObjectId,
  beside: ReadonlyArray<{ readonly path: string; readonly text: string }> = TRACKED_K,
): Promise<ObjectId> => {
  await seedIndex(ctx, [...beside, { path, text: 'recorded\n', mode: FILE_MODE.GITLINK }]);
  const index = await readIndex(ctx);
  const entries = index.entries.map((e) => (e.path === path ? { ...e, id } : e));
  invalidateIndexCache(ctx);
  await ctx.fs.write(
    `${ctx.layout.gitDir}/index`,
    await serializeIndexFixtureAsync({ ...index, entries, extensions: [] }, ctx),
  );
  invalidateIndexCache(ctx);
  return (await commit(ctx, { message: 'record', author: SUBMODULE_AUTHOR })).id;
};

/**
 * A committed superproject tracking `k` whose gitlink at `path` records the HEAD of a real,
 * clean submodule holding `u`, its repository under `<gitDir>/modules/<name>` behind a gitfile.
 */
export const withSubmodule = async (path = 'sub', name = 'sub'): Promise<SubmoduleFixture> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(workPath(ctx, 'k'), 'k\n');
  const child = deriveGitlinkContext(ctx, `${ctx.layout.gitDir}/modules/${name}`, path as FilePath);
  await init(child);
  const climb = '../'.repeat(path.split('/').length);
  await ctx.fs.writeUtf8(workPath(ctx, `${path}/.git`), `gitdir: ${climb}.git/modules/${name}\n`);
  await ctx.fs.writeUtf8(workPath(ctx, `${path}/u`), 'u\n');
  await seedIndex(child, [{ path: 'u', text: 'u\n' }]);
  const { id } = await commit(child, { message: 'child', author: SUBMODULE_AUTHOR });
  await recordGitlink(ctx, path, id);
  return { ctx, child };
};

/** Turn the gitfile submodule at `path` into one carrying its repository in `<path>/.git`. */
export const embedRepository = async (
  ctx: Context,
  path: string,
  moduleDir: string,
): Promise<void> => {
  await ctx.fs.rm(workPath(ctx, `${path}/.git`));
  await ctx.fs.rename(moduleDir, workPath(ctx, `${path}/.git`));
};

export const GITMODULES_IN = '[submodule "in"]\n\tpath = in\n\turl = ../up\n';

/**
 * A nested submodule `in` inside `sub`, its repository under `sub`'s own `modules/in` behind a
 * gitfile, recorded in `sub`'s index beside `u` and, unless told otherwise, named in a tracked
 * `sub/.gitmodules`; the checkout stays clean.
 */
export const withNestedSubmodule = async (
  { ctx, child }: SubmoduleFixture,
  {
    named = true,
    gitmodules = GITMODULES_IN,
  }: { readonly named?: boolean; readonly gitmodules?: string } = {},
): Promise<Context> => {
  const nested = deriveGitlinkContext(child, `${child.layout.gitDir}/modules/in`, 'in' as FilePath);
  await init(nested);
  await ctx.fs.writeUtf8(
    workPath(ctx, 'sub/in/.git'),
    'gitdir: ../../.git/modules/sub/modules/in\n',
  );
  await ctx.fs.writeUtf8(workPath(ctx, 'sub/in/w'), 'w\n');
  await seedIndex(nested, [{ path: 'w', text: 'w\n' }]);
  const { id } = await commit(nested, { message: 'nested', author: SUBMODULE_AUTHOR });
  const tracked = [{ path: 'u', text: 'u\n' }];
  if (named) {
    await ctx.fs.writeUtf8(workPath(ctx, 'sub/.gitmodules'), gitmodules);
    tracked.push({ path: '.gitmodules', text: gitmodules });
  }
  const childHead = await recordGitlink(child, 'in', id, tracked);
  await recordGitlink(ctx, 'sub', childHead);
  return nested;
};

/** Advance the submodule's HEAD by one commit adding `v`, leaving its index and files clean. */
export const advanceSubmodule = async (
  ctx: Context,
  child: Context,
  path = 'sub',
): Promise<ObjectId> => {
  await ctx.fs.writeUtf8(workPath(ctx, `${path}/v`), 'v\n');
  await seedIndex(child, [
    { path: 'u', text: 'u\n' },
    { path: 'v', text: 'v\n' },
  ]);
  return (await commit(child, { message: 'advance', author: SUBMODULE_AUTHOR })).id;
};
