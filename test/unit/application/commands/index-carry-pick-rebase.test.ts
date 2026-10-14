import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { cherryPickRun } from '../../../../src/application/commands/cherry-pick.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { mergeRun } from '../../../../src/application/commands/merge.js';
import { rebaseRun } from '../../../../src/application/commands/rebase.js';
import { revertRun } from '../../../../src/application/commands/revert.js';
import { updateConfigEntries } from '../../../../src/application/primitives/update-config.js';
import type { CacheTreeEntry } from '../../../../src/domain/git-index/index-entry.js';
import { parseCacheTree } from '../../../../src/domain/git-index/index-parser.js';
import type { AuthorIdentity, ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import {
  cacheTreeExtension,
  indexExtensionsOf,
  resolveUndoExtension,
  UNKNOWN_EXTENSION,
  UNTR_EXTENSION,
  withIndexExtensions,
} from '../primitives/helpers/index-extensions.js';

const SHA1_DIGEST = 20;
const TREE_ID = 'c'.repeat(40) as ObjectId;
const BLOB_ID = 'b'.repeat(40);
const T0 = 1_700_000_000_000;
const SECOND = 1000;
const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};
const FILES: Readonly<Record<string, string>> = {
  a: 'a\n',
  b: 'b\n',
  'd/c': 'c\n',
  'd/e/f': 'f\n',
  'x/y': 'y\n',
};

const node = (
  path: string,
  entryCount: number,
  subtreeCount: number,
  children: ReadonlyArray<CacheTreeEntry> = [],
): CacheTreeEntry => ({ path, entryCount, subtreeCount, id: TREE_ID, children });

const fullTree = (): CacheTreeEntry =>
  node('', 5, 2, [node('d', 2, 1, [node('e', 1, 0)]), node('x', 1, 0)]);

const advance = (seconds: number): void => {
  vi.setSystemTime(Date.now() + seconds * SECOND);
};

const write = (ctx: Context, path: string, content: string): Promise<void> =>
  ctx.fs.writeUtf8(`${ctx.layout.workDir}/${path}`, content);

const commitAll = async (ctx: Context, message: string, paths: string[]): Promise<ObjectId> => {
  await add(ctx, paths);
  advance(1);
  const result = await commit(ctx, { message, author: AUTHOR, committer: AUTHOR });
  advance(1);
  return result.id;
};

const carryAllExtensions = async (ctx: Context): Promise<void> => {
  await withIndexExtensions(ctx, [
    cacheTreeExtension(fullTree(), SHA1_DIGEST),
    resolveUndoExtension('m', BLOB_ID, SHA1_DIGEST),
    UNTR_EXTENSION,
    UNKNOWN_EXTENSION,
  ]);
  advance(1);
};

interface Repo {
  readonly ctx: Context;
  readonly base: ObjectId;
  readonly other: ObjectId;
}

/** `main` = c1 (FILES); `other` = c1 then `otherChange` committed. Left on `main` at c1. */
const forkedRepo = async (otherChange: Readonly<Record<string, string>>): Promise<Repo> => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  const ctx = createMemoryContext();
  await init(ctx);
  await updateConfigEntries(ctx, [
    { section: 'user', key: 'name', value: AUTHOR.name },
    { section: 'user', key: 'email', value: AUTHOR.email },
  ]);
  for (const [path, content] of Object.entries(FILES)) await write(ctx, path, content);
  const base = await commitAll(ctx, 'c1', Object.keys(FILES));
  await checkout(ctx, { rev: 'HEAD', createBranch: { name: 'other' } });
  advance(1);
  for (const [path, content] of Object.entries(otherChange)) await write(ctx, path, content);
  const other = await commitAll(ctx, 'other', Object.keys(otherChange));
  await checkout(ctx, { rev: 'main' });
  advance(1);
  return { ctx, base, other };
};

const validity = async (ctx: Context): Promise<ReadonlyMap<string, boolean>> => {
  const extensions = await indexExtensionsOf(ctx);
  const tree = parseCacheTree(extensions.get('TREE') as Uint8Array, SHA1_DIGEST);
  const out = new Map<string, boolean>();
  const visit = (entry: CacheTreeEntry, prefix: string): void => {
    out.set(prefix, entry.entryCount >= 0);
    for (const child of entry.children)
      visit(child, prefix === '' ? child.path : `${prefix}/${child.path}`);
  };
  visit(tree, '');
  return out;
};

const signatures = async (ctx: Context): Promise<ReadonlyArray<string>> => [
  ...(await indexExtensionsOf(ctx)).keys(),
];

const chains = async (ctx: Context): Promise<ReadonlyArray<boolean | undefined>> => {
  const valid = await validity(ctx);
  return [valid.get(''), valid.get('d'), valid.get('d/e'), valid.get('x')];
};

const OTHER_CHANGE = { 'x/y': 'other\n', 'z/w': 'w\n' };

afterEach(() => {
  vi.useRealTimers();
});

describe('cherry-pick carries index extensions', () => {
  describe('Given a commit on another branch that applies cleanly', () => {
    describe('When cherry-pick picks it', () => {
      it('Then REUC, UNTR and the unknown extension are dropped and only the changed chains are invalid', async () => {
        // Arrange
        const { ctx, other } = await forkedRepo(OTHER_CHANGE);
        await carryAllExtensions(ctx);

        // Act
        const sut = cherryPickRun;
        await sut(ctx, { commits: [other] });

        // Assert
        expect(await signatures(ctx)).toEqual(['TREE']);
        expect(await chains(ctx)).toEqual([false, true, true, false]);
      });
    });
  });

  describe('Given a commit editing a file the current branch also edited', () => {
    describe('When cherry-pick stops on the conflict', () => {
      it('Then REUC is dropped, UNTR is kept as the tracked set is unchanged and the conflicted chain is invalid', async () => {
        // Arrange
        const { ctx, other } = await forkedRepo({ 'x/y': 'other\n' });
        await write(ctx, 'x/y', 'main\n');
        await commitAll(ctx, 'c2', ['x/y']);
        await carryAllExtensions(ctx);

        // Act
        const sut = cherryPickRun;
        const result = await sut(ctx, { commits: [other] });

        // Assert
        expect(result.kind).toBe('conflict');
        expect(await signatures(ctx)).toEqual(['TREE', 'UNTR']);
        expect(await chains(ctx)).toEqual([false, true, true, false]);
      });
    });
  });

  describe('Given a commit applied without committing', () => {
    describe('When cherry-pick --no-commit accumulates it into the index', () => {
      it('Then REUC and the unknown extension are dropped, UNTR is kept and the changed chain is invalid', async () => {
        // Arrange
        const { ctx, other } = await forkedRepo({ 'x/y': 'other\n' });
        await carryAllExtensions(ctx);

        // Act
        const sut = cherryPickRun;
        await sut(ctx, { commits: [other], noCommit: true });

        // Assert
        expect(await signatures(ctx)).toEqual(['TREE', 'UNTR']);
        expect(await chains(ctx)).toEqual([false, true, true, false]);
      });
    });
  });
});

describe('revert carries index extensions', () => {
  describe('Given a commit on the current branch', () => {
    describe('When revert undoes it cleanly', () => {
      it('Then REUC and the unknown extension are dropped, UNTR is kept as the tracked set is unchanged and only the changed chains are invalid', async () => {
        // Arrange
        const { ctx } = await forkedRepo(OTHER_CHANGE);
        await write(ctx, 'x/y', 'main\n');
        const c2 = await commitAll(ctx, 'c2', ['x/y']);
        await carryAllExtensions(ctx);

        // Act
        const sut = revertRun;
        await sut(ctx, { commits: [c2] });

        // Assert
        expect(await signatures(ctx)).toEqual(['TREE', 'UNTR']);
        expect(await chains(ctx)).toEqual([false, true, true, false]);
      });
    });
  });
});

describe('rebase carries index extensions', () => {
  describe('Given a branch whose commit replays cleanly onto a moved upstream', () => {
    describe('When rebase replays it', () => {
      it('Then REUC and the unknown extension are dropped and only the changed chains are invalid', async () => {
        // Arrange
        const { ctx } = await forkedRepo(OTHER_CHANGE);
        await write(ctx, 'b', 'b2\n');
        await commitAll(ctx, 'c2', ['b']);
        await checkout(ctx, { rev: 'other' });
        advance(1);
        await carryAllExtensions(ctx);

        // Act
        const sut = rebaseRun;
        await sut(ctx, { upstream: 'main' });

        // Assert
        expect(await signatures(ctx)).toEqual(['TREE']);
        expect(await chains(ctx)).toEqual([false, true, true, false]);
      });
    });
  });

  describe('Given a branch holding a merge commit', () => {
    describe('When rebase --rebase-merges recreates the merge', () => {
      it('Then REUC and the unknown extension are dropped and only the changed chains are invalid', async () => {
        // Arrange
        const { ctx } = await forkedRepo({ 'z/w': 'w\n' });
        await write(ctx, 'b', 'b2\n');
        await commitAll(ctx, 'c2', ['b']);
        await checkout(ctx, { rev: 'main~1', createBranch: { name: 'topic' } });
        advance(1);
        await write(ctx, 'x/y', 'topic\n');
        await commitAll(ctx, 't1', ['x/y']);
        await mergeRun(ctx, { rev: 'other', author: AUTHOR });
        advance(1);
        await carryAllExtensions(ctx);

        // Act
        const sut = rebaseRun;
        await sut(ctx, { upstream: 'main', rebaseMerges: true });

        // Assert
        expect(await signatures(ctx)).toEqual(['TREE']);
        expect(await chains(ctx)).toEqual([false, true, true, false]);
      });
    });
  });

  describe('Given a branch whose hand-resolved merge conflicts again when recreated', () => {
    describe('When rebase --rebase-merges stops on the merge conflict', () => {
      it('Then REUC, UNTR and the unknown extension are dropped as the conflict changes the tracked set', async () => {
        // Arrange
        const { ctx } = await forkedRepo({ 'x/y': 'other\n' });
        await write(ctx, 'a', 'a2\n');
        await commitAll(ctx, 'c2', ['a']);
        await checkout(ctx, { rev: 'main~1', createBranch: { name: 'topic' } });
        advance(1);
        await write(ctx, 'b', 'b2\n');
        await commitAll(ctx, 't1', ['b']);
        await checkout(ctx, { rev: 'topic', createBranch: { name: 'side' } });
        advance(1);
        await write(ctx, 'z/y', 's\n');
        await commitAll(ctx, 's1', ['z/y']);
        await checkout(ctx, { rev: 'topic' });
        advance(1);
        await write(ctx, 'z/y', 't\n');
        await commitAll(ctx, 't2', ['z/y']);
        await mergeRun(ctx, { rev: 'side', fastForward: 'never', author: AUTHOR });
        await write(ctx, 'z/y', 'st\n');
        await commitAll(ctx, 'merge', ['z/y']);
        await carryAllExtensions(ctx);

        // Act
        const sut = rebaseRun;
        const result = await sut(ctx, { upstream: 'main', rebaseMerges: true });

        // Assert
        expect(result.kind).toBe('conflict');
        expect(await signatures(ctx)).toEqual(['TREE']);
      });
    });
  });
});
