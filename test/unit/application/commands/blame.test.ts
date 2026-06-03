import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { blame } from '../../../../src/application/commands/blame.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { AuthorIdentity, ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const ident = (name: string, timestamp: number): AuthorIdentity => ({
  name,
  email: `${name}@example.com`,
  timestamp,
  timezoneOffset: '+0000',
});

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

let clock = 1_700_000_000;

const commitFile = async (
  ctx: Context,
  name: string,
  path: string,
  content: string,
): Promise<ObjectId> => {
  clock += 60;
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${path}`, content);
  await add(ctx, [path]);
  const result = await commit(ctx, {
    message: `${name} subject\n\nbody`,
    author: ident(name, clock),
    committer: ident(name, clock),
  });
  return result.id;
};

const seed = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  return ctx;
};

describe('Given a linear history that modifies one line and appends another', () => {
  describe('When blaming the file', () => {
    it('Then each line is attributed to the commit that last touched it', async () => {
      // Arrange
      const ctx = await seed();
      const c1 = await commitFile(ctx, 'c1', 'f.txt', 'line1\nline2\nline3\n');
      const c2 = await commitFile(ctx, 'c2', 'f.txt', 'line1\nline2-mod\nline3\nline4\n');

      // Act
      const sut = await blame(ctx, 'f.txt');

      // Assert
      expect(sut.lines.map((l) => l.commit)).toEqual([c1, c2, c1, c2]);
      expect(sut.lines.map((l) => l.finalLine)).toEqual([1, 2, 3, 4]);
      expect(sut.lines.map((l) => text(l.content))).toEqual([
        'line1\n',
        'line2-mod\n',
        'line3\n',
        'line4\n',
      ]);
    });

    it('Then root-commit lines are boundaries and later-commit lines carry previous', async () => {
      // Arrange
      const ctx = await seed();
      const c1 = await commitFile(ctx, 'c1', 'f.txt', 'line1\nline2\nline3\n');
      await commitFile(ctx, 'c2', 'f.txt', 'line1\nline2-mod\nline3\nline4\n');

      // Act
      const sut = await blame(ctx, 'f.txt');

      // Assert
      expect(sut.lines[0]!.boundary).toBe(true);
      expect(sut.lines[0]!.previous).toBeUndefined();
      expect(sut.lines[1]!.boundary).toBe(false);
      expect(sut.lines[1]!.previous).toEqual({ commit: c1, path: 'f.txt' });
    });
  });
});

describe('Given a commit that prepends lines above existing content', () => {
  describe('When blaming the file', () => {
    it('Then surviving lines keep their source line but gain a new final line', async () => {
      // Arrange
      const ctx = await seed();
      const c1 = await commitFile(ctx, 'c1', 'f.txt', 'orig1\norig2\n');
      const c2 = await commitFile(ctx, 'c2', 'f.txt', 'new1\nnew2\norig1\norig2\n');

      // Act
      const sut = await blame(ctx, 'f.txt');

      // Assert
      expect(sut.lines.map((l) => l.commit)).toEqual([c2, c2, c1, c1]);
      expect(sut.lines.map((l) => l.finalLine)).toEqual([1, 2, 3, 4]);
      expect(sut.lines.map((l) => l.sourceLine)).toEqual([1, 2, 1, 2]);
    });
  });
});

describe('Given a single root commit', () => {
  describe('When blaming the file', () => {
    it('Then the line is a boundary carrying the commit subject', async () => {
      // Arrange
      const ctx = await seed();
      const c1 = await commitFile(ctx, 'c1', 'f.txt', 'only\n');

      // Act
      const sut = await blame(ctx, 'f.txt');

      // Assert
      expect(sut.lines).toHaveLength(1);
      expect(sut.lines[0]!.commit).toBe(c1);
      expect(sut.lines[0]!.boundary).toBe(true);
      expect(sut.lines[0]!.summary).toBe('c1 subject');
      expect(sut.lines[0]!.sourcePath).toBe('f.txt');
    });
  });
});

describe('Given an empty file', () => {
  describe('When blaming it', () => {
    it('Then no lines are reported', async () => {
      // Arrange
      const ctx = await seed();
      await commitFile(ctx, 'c1', 'empty.txt', '');

      // Act
      const sut = await blame(ctx, 'empty.txt');

      // Assert
      expect(sut.lines).toEqual([]);
      expect(sut.path).toBe('empty.txt');
    });
  });
});

describe('Given a path absent from the revision', () => {
  describe('When blaming it', () => {
    it('Then it refuses with PATH_NOT_IN_TREE', async () => {
      // Arrange
      const ctx = await seed();
      await commitFile(ctx, 'c1', 'f.txt', 'a\n');

      // Act + Assert
      try {
        await blame(ctx, 'missing.txt');
        expect.unreachable('blame should refuse an absent path');
      } catch (error) {
        expect(error).toBeInstanceOf(TsgitError);
        expect((error as TsgitError).data).toMatchObject({
          code: 'PATH_NOT_IN_TREE',
          path: 'missing.txt',
        });
      }
    });
  });
});

describe('Given an explicit older revision', () => {
  describe('When blaming the file as of that revision', () => {
    it('Then only that revision content is blamed', async () => {
      // Arrange
      const ctx = await seed();
      const c1 = await commitFile(ctx, 'c1', 'f.txt', 'line1\nline2\n');
      await commitFile(ctx, 'c2', 'f.txt', 'line1\nline2-mod\n');

      // Act
      const sut = await blame(ctx, 'f.txt', { rev: c1 });

      // Assert
      expect(sut.lines.map((l) => l.commit)).toEqual([c1, c1]);
      expect(sut.lines.map((l) => text(l.content))).toEqual(['line1\n', 'line2\n']);
    });
  });
});
