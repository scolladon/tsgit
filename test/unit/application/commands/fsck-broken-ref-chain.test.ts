/**
 * A ref whose chain fails to resolve to an object is reported with a zero pointer,
 * as are the refs that lead to it: the listing difference names every one.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { fsck } from '../../../../src/application/commands/fsck.js';
import { init } from '../../../../src/application/commands/init.js';
import { __resetConfigCacheForTests } from '../../../../src/application/primitives/config-read.js';
import type { Context } from '../../../../src/ports/context.js';

const ZERO_POINTER = '0'.repeat(40);
const EXIT_MISSING_AND_CONTENT = 10;
const EXIT_MISSING = 2;

const repository = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  return ctx;
};

const plant = (ctx: Context, name: string, body: string): Promise<void> =>
  ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/${name}`, body);

const pointersOf = (result: Awaited<ReturnType<typeof fsck>>) =>
  result.findings.flatMap((finding) =>
    finding.type === 'bad-ref' && finding.msgId === 'badRefOid'
      ? [{ ref: finding.ref, target: finding.target }]
      : [],
  );

const pointers = (...names: ReadonlyArray<string>) =>
  names.map((name) => ({ ref: `refs/heads/${name}`, target: ZERO_POINTER }));

describe('Given a symbolic ref leading to a ref holding garbage', () => {
  describe.each([
    { shape: 'the symbolic ref sorts first', from: 'a', expected: ['a', 'b'] },
    { shape: 'the symbolic ref sorts last', from: 'z', expected: ['b', 'z'] },
  ])('$shape', ({ from, expected }) => {
    describe('When fsck runs', () => {
      it('Then every ref of the chain gets a zero pointer, in name order', async () => {
        // Arrange
        const ctx = await repository();
        await plant(ctx, from, 'ref: refs/heads/b\n');
        await plant(ctx, 'b', 'garbage\n');
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(pointersOf(result)).toEqual(pointers(...expected));
        expect(result.exitCode).toBe(EXIT_MISSING_AND_CONTENT);
      });
    });
  });
});

describe('Given a chain of three ending on garbage and a symbolic ref sorting last', () => {
  describe('When fsck runs', () => {
    it('Then each ref of both chains gets one zero pointer, in name order', async () => {
      // Arrange
      const ctx = await repository();
      await plant(ctx, 'a', 'ref: refs/heads/b\n');
      await plant(ctx, 'b', 'ref: refs/heads/c\n');
      await plant(ctx, 'c', 'garbage\n');
      await plant(ctx, 'z', 'ref: refs/heads/c\n');
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(pointersOf(result)).toEqual(pointers('a', 'b', 'c', 'z'));
    });
  });
});

describe('Given a ref holding garbage alone', () => {
  describe('When fsck runs', () => {
    it('Then exactly one zero pointer is reported', async () => {
      // Arrange
      const ctx = await repository();
      await plant(ctx, 'b', 'garbage\n');
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(pointersOf(result)).toEqual(pointers('b'));
    });
  });
});

describe('Given a ref holding sixty-four hex digits in a SHA-1 repository', () => {
  describe('When fsck runs', () => {
    it('Then it gets a zero pointer', async () => {
      // Arrange
      const ctx = await repository();
      await plant(ctx, 'b', `${'a'.repeat(64)}\n`);
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(pointersOf(result)).toEqual(pointers('b'));
    });
  });
});

describe('Given a symbolic ref leading to a ref whose referent is not a ref name', () => {
  describe.each([
    { shape: 'the symbolic ref sorts first', from: 'a', expected: ['a', 'b'] },
    { shape: 'the symbolic ref sorts last', from: 'z', expected: ['b', 'z'] },
  ])('$shape', ({ from, expected }) => {
    describe('When fsck runs', () => {
      it('Then every ref of the chain gets a zero pointer', async () => {
        // Arrange
        const ctx = await repository();
        await plant(ctx, from, 'ref: refs/heads/b\n');
        await plant(ctx, 'b', 'ref: x..y\n');
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(pointersOf(result)).toEqual(pointers(...expected));
      });
    });
  });
});

describe('Given a symbolic ref whose target does not exist', () => {
  describe.each([
    { shape: 'sorting first', from: 'a' },
    { shape: 'sorting last', from: 'z' },
  ])('$shape', ({ from }) => {
    describe('When fsck runs', () => {
      it('Then it gets one zero pointer and exits 2', async () => {
        // Arrange
        const ctx = await repository();
        await plant(ctx, from, 'ref: refs/heads/b\n');
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(pointersOf(result)).toEqual(pointers(from));
        expect(result.exitCode).toBe(EXIT_MISSING);
      });
    });
  });
});

describe('Given a loose ref holding garbage that shadows a packed ref of the same name', () => {
  describe.each([
    { shape: 'sorting first', name: 'a' },
    { shape: 'sorting last', name: 'z' },
  ])('$shape', ({ name }) => {
    describe('When fsck runs', () => {
      it('Then the shadow gets a zero pointer, not the packed value', async () => {
        // Arrange
        const ctx = await repository();
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/packed-refs`,
          `# pack-refs with: peeled fully-peeled sorted \n${'1'.repeat(40)} refs/heads/${name}\n`,
        );
        await plant(ctx, name, 'garbage\n');
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(pointersOf(result)).toEqual(pointers(name));
      });
    });
  });
});

describe('Given a symbolic link onto a ref holding garbage', () => {
  describe.each([
    { shape: 'the link sorts first', link: 'a', expected: ['a', 'm'] },
    { shape: 'the link sorts last', link: 'z', expected: ['m', 'z'] },
  ])('$shape', ({ link, expected }) => {
    describe('When fsck runs', () => {
      it('Then the link gets its zero pointer under its own name', async () => {
        // Arrange
        const ctx = await repository();
        await plant(ctx, 'm', 'garbage\n');
        await ctx.fs.symlink('m', `${ctx.layout.gitDir}/refs/heads/${link}`);
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(pointersOf(result)).toEqual(pointers(...expected));
      });
    });
  });
});

const GARBAGE = 'garbage\n';

const badContentRefs = (result: Awaited<ReturnType<typeof fsck>>): ReadonlyArray<string> =>
  result.findings.flatMap((finding) =>
    finding.type === 'bad-ref' && finding.msgId === 'badRefContent' ? [finding.ref] : [],
  );

const plantRoot = (ctx: Context, name: string, body: string): Promise<void> =>
  ctx.fs.writeUtf8(`${ctx.layout.gitDir}/${name}`, body);

describe('Given two root refs holding garbage', () => {
  describe.each([
    { shape: 'the gitdir lists the lower name first', first: 'AAA_HEAD', second: 'ZED_HEAD' },
    { shape: 'the gitdir lists the higher name first', first: 'ZED_HEAD', second: 'AAA_HEAD' },
  ])('$shape', ({ first, second }) => {
    describe('When fsck runs', () => {
      it('Then only the first root ref is reported, as git stops at its first error', async () => {
        // Arrange
        const ctx = await repository();
        await plantRoot(ctx, first, GARBAGE);
        await plantRoot(ctx, second, GARBAGE);
        const sut = fsck;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(badContentRefs(result)).toEqual([first]);
      });
    });
  });
});

describe('Given a ref under refs/ and two root refs holding garbage', () => {
  describe('When fsck runs', () => {
    it('Then the refs/ finding and the first root finding are reported', async () => {
      // Arrange
      const ctx = await repository();
      await plant(ctx, 'a', GARBAGE);
      await plantRoot(ctx, 'BAR_HEAD', GARBAGE);
      await plantRoot(ctx, 'ZED_HEAD', GARBAGE);
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(badContentRefs(result)).toEqual(['refs/heads/a', 'BAR_HEAD']);
    });
  });
});

describe('Given two root refs holding garbage and badRefContent re-typed as a warning', () => {
  describe('When fsck runs', () => {
    it('Then both are reported, as no error ended the root-ref check', async () => {
      // Arrange
      __resetConfigCacheForTests();
      const ctx = await repository();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[fsck]\n\tbadRefContent = warn\n');
      await plantRoot(ctx, 'AAA_HEAD', GARBAGE);
      await plantRoot(ctx, 'ZED_HEAD', GARBAGE);
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(badContentRefs(result)).toEqual(['AAA_HEAD', 'ZED_HEAD']);
    });
  });
});
