import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { mergeRun } from '../../../../src/application/commands/merge.js';
import { resolveRef } from '../../../../src/application/primitives/resolve-ref.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { seedIndex } from './add-index-fixtures.js';
import { recordGitlink } from './submodule-fixtures.js';

const AUTHOR = { name: 'Ada', email: 'a@x', timestamp: 100, timezoneOffset: '+0000' };

const write = (ctx: Context, name: string, body: string): Promise<void> =>
  ctx.fs.writeUtf8(`${ctx.layout.workDir}/${name}`, body);

const readWork = (ctx: Context, name: string): Promise<string> =>
  ctx.fs.readUtf8(`${ctx.layout.workDir}/${name}`);

const commitFile = async (ctx: Context, name: string, body: string): Promise<void> => {
  await write(ctx, name, body);
  await add(ctx, [name]);
  await commit(ctx, { message: `${name} ${body.trim()}`, author: AUTHOR });
};

const branchFromMain = async (ctx: Context, name: string): Promise<void> => {
  await checkout(ctx, { rev: 'main' });
  await branchCreate(ctx, { name });
  await checkout(ctx, { rev: name });
};

/** `x1` edits the tracked `a`; `x2` adds `x2`; `main` adds `m`. */
const diverged = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx, { initialBranch: 'main' });
  await commitFile(ctx, 'a', 'a\n');
  await branchFromMain(ctx, 'x1');
  await commitFile(ctx, 'a', 'a-x1\n');
  await branchFromMain(ctx, 'x2');
  await commitFile(ctx, 'x2', 'x2\n');
  await checkout(ctx, { rev: 'main' });
  await commitFile(ctx, 'm', 'm\n');
  return ctx;
};

/** `main` and `t` both edit `keep`; `t` also adds `d/x` and `d/y`, while an untracked `d` stands in the way. */
const divergedWithAddsUnder = async (obstacle: string, exclude: string): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx, { initialBranch: 'main' });
  await commitFile(ctx, 'keep', 'k0\n');
  await branchFromMain(ctx, 't');
  await commitFile(ctx, 'keep', 'kT\n');
  await commitFile(ctx, `${obstacle}/x`, 'x\n');
  await commitFile(ctx, `${obstacle}/y`, 'y\n');
  await checkout(ctx, { rev: 'main' });
  await commitFile(ctx, 'keep', 'kM\n');
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/info/exclude`, exclude);
  await write(ctx, obstacle, 'obstacle\n');
  return ctx;
};

const dataOf = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    return (error as TsgitError).data;
  }
  throw new Error('expected a refusal');
};

describe('merge — the work tree must take the merged tree before a strategy commits it', () => {
  describe('Given an octopus whose merge rewrites a locally edited tracked file', () => {
    describe('When merge runs', () => {
      it('Then the octopus strategy fails and the edit and HEAD are kept', async () => {
        // Arrange
        const ctx = await diverged();
        const head = await resolveRef(ctx, 'HEAD' as RefName);
        await write(ctx, 'a', 'LOCAL\n');

        // Act
        const sut = mergeRun;
        const data = await dataOf(() => sut(ctx, { rev: ['x1', 'x2'], author: AUTHOR }));

        // Assert
        expect(data).toEqual({ code: 'MERGE_STRATEGY_FAILED', strategy: 'octopus' });
        expect(await readWork(ctx, 'a')).toBe('LOCAL\n');
        expect(await resolveRef(ctx, 'HEAD' as RefName)).toBe(head);
      });
    });
  });

  describe('Given an octopus whose merge adds a file over an untracked one', () => {
    describe('When merge runs', () => {
      it('Then the octopus strategy fails and the untracked file is kept', async () => {
        // Arrange
        const ctx = await diverged();
        const head = await resolveRef(ctx, 'HEAD' as RefName);
        await write(ctx, 'x2', 'UNTRACKED\n');

        // Act
        const sut = mergeRun;
        const data = await dataOf(() => sut(ctx, { rev: ['x1', 'x2'], author: AUTHOR }));

        // Assert
        expect(data).toEqual({ code: 'MERGE_STRATEGY_FAILED', strategy: 'octopus' });
        expect(await readWork(ctx, 'x2')).toBe('UNTRACKED\n');
        expect(await resolveRef(ctx, 'HEAD' as RefName)).toBe(head);
      });
    });
  });

  describe('Given a resolve merge that rewrites a locally edited file', () => {
    describe('When merge runs', () => {
      it('Then the dirty tree is refused and the file is kept', async () => {
        // Arrange
        const ctx = await diverged();
        await write(ctx, 'a', 'LOCAL\n');

        // Act
        const sut = mergeRun;
        const data = await dataOf(() =>
          sut(ctx, { rev: 'x1', strategy: 'resolve', author: AUTHOR }),
        );

        // Assert
        expect(data).toEqual({ code: 'MERGE_STRATEGY_FAILED', strategy: 'resolve' });
        expect(await readWork(ctx, 'a')).toBe('LOCAL\n');
      });
    });
  });

  describe('Given a resolve merge that adds a file over an untracked one', () => {
    describe('When merge runs', () => {
      it('Then the dirty tree is refused and the file is kept', async () => {
        // Arrange
        const ctx = await diverged();
        await write(ctx, 'x2', 'UNTRACKED\n');

        // Act
        const sut = mergeRun;
        const data = await dataOf(() =>
          sut(ctx, { rev: 'x2', strategy: 'resolve', author: AUTHOR }),
        );

        // Assert
        expect(data).toEqual({ code: 'MERGE_STRATEGY_FAILED', strategy: 'resolve' });
        expect(await readWork(ctx, 'x2')).toBe('UNTRACKED\n');
      });
    });
  });

  describe.each([
    {
      label: 'a locally edited tracked file',
      dirty: (ctx: Context) => write(ctx, 'a', 'LOCAL\n'),
      revs: ['x1', 'x2'],
    },
    {
      label: 'an untracked file in the way',
      dirty: (ctx: Context) => write(ctx, 'x2', 'UNTRACKED\n'),
      revs: ['x1', 'x2'],
    },
  ])('Given a signed octopus merge over $label', ({ dirty, revs }) => {
    describe('When merge runs', () => {
      it('Then the dirty tree is refused before the commit is signed', async () => {
        // Arrange
        const ctx = await diverged();
        await dirty(ctx);

        // Act
        const sut = mergeRun;
        const data = await dataOf(() => sut(ctx, { rev: revs, sign: true, author: AUTHOR }));

        // Assert
        expect(data).toEqual({ code: 'MERGE_STRATEGY_FAILED', strategy: 'octopus' });
      });
    });
  });

  describe.each([
    { label: 'a locally edited tracked file', rev: 'x1', dirty: 'a' },
    { label: 'an untracked file in the way', rev: 'x2', dirty: 'x2' },
  ])('Given a signed resolve merge over $label', ({ rev, dirty }) => {
    describe('When merge runs', () => {
      it('Then the dirty tree is refused before the commit is signed', async () => {
        // Arrange
        const ctx = await diverged();
        await write(ctx, dirty, 'LOCAL\n');

        // Act
        const sut = mergeRun;
        const data = await dataOf(() =>
          sut(ctx, { rev, strategy: 'resolve', sign: true, author: AUTHOR }),
        );

        // Assert
        expect(data).toEqual({ code: 'MERGE_STRATEGY_FAILED', strategy: 'resolve' });
      });
    });
  });

  describe('Given a clean merge whose signing fails', () => {
    describe('When merge runs', () => {
      it('Then MERGE_MSG keeps the message without its final newline, as git writes it', async () => {
        // Arrange
        const ctx = await diverged();

        // Act
        await mergeRun(ctx, { rev: 'x1', message: 'Merge it', sign: true, author: AUTHOR }).catch(
          () => undefined,
        );

        // Assert
        expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/MERGE_MSG`)).toBe('Merge it');
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_HEAD`)).toBe(true);
      });
    });
  });

  describe('Given both sides moved a submodule to different commits', () => {
    describe('When merge runs', () => {
      it('Then it refuses the gitlink conflict before leaving any merge state', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        await recordGitlink(ctx, 'sub', 'a'.repeat(40) as ObjectId);
        await branchFromMain(ctx, 'theirs');
        await recordGitlink(ctx, 'sub', 'b'.repeat(40) as ObjectId);
        await checkout(ctx, { rev: 'main' });
        const head = await recordGitlink(ctx, 'sub', 'c'.repeat(40) as ObjectId);

        // Act
        const sut = mergeRun;
        const data = await dataOf(() => sut(ctx, { rev: 'theirs', author: AUTHOR }));

        // Assert
        expect(data).toEqual({
          code: 'UNSUPPORTED_OPERATION',
          operation: 'merge',
          reason: "conflict type 'gitlink' not supported in v1 (path=sub)",
        });
        expect(await resolveRef(ctx, 'HEAD' as RefName)).toBe(head);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_HEAD`)).toBe(false);
      });
    });
  });

  describe.each([
    { label: 'a plain name', exclude: 'd\n' },
    { label: 'a rule re-including only directories', exclude: 'd\n!d/\n' },
  ])(
    'Given an ignored file under $label where the merge adds two paths beneath it and conflicts elsewhere',
    ({ exclude }) => {
      describe('When merge runs', () => {
        it('Then both paths are written and the ignored file is gone', async () => {
          // Arrange
          const ctx = await divergedWithAddsUnder('d', exclude);

          // Act
          const sut = mergeRun;
          const result = await sut(ctx, { rev: 't', author: AUTHOR });

          // Assert
          expect(result.kind).toBe('conflict');
          expect([await readWork(ctx, 'd/x'), await readWork(ctx, 'd/y')]).toEqual(['x\n', 'y\n']);
        });
      });
    },
  );

  describe('Given an ignored work-tree file named like a path whose bytes are not UTF-8', () => {
    describe('When merge adds a path beneath that byte name and conflicts elsewhere', () => {
      it('Then the file is left alone, as no work-tree name can be looked up for those bytes', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx, { initialBranch: 'main' });
        await commitFile(ctx, 'keep', 'k0\n');
        await branchFromMain(ctx, 't');
        await commitFile(ctx, 'keep', 'kT\n');
        await seedIndex(ctx, [
          { path: 'keep', text: 'kT\n' },
          { path: Uint8Array.of(0xff, 0x2f, 0x78), text: 'x\n' },
        ]);
        await commit(ctx, { message: 'bytes', author: AUTHOR });
        await checkout(ctx, { rev: 'main' });
        await commitFile(ctx, 'keep', 'kM\n');
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/info/exclude`, '*\n!keep\n');
        const name = String.fromCharCode(0xdcff);
        await write(ctx, name, 'bystander\n');

        // Act
        const sut = mergeRun;
        const result = await sut(ctx, { rev: 't', author: AUTHOR });

        // Assert
        expect(result.kind).toBe('conflict');
        expect(await readWork(ctx, name)).toBe('bystander\n');
      });
    });
  });
});
