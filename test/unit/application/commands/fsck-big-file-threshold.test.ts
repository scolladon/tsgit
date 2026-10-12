/**
 * A malformed `core.bigFileThreshold` (last entry wins): git's fsck reads it
 * the first time it reads an object's content, so it refuses once there is
 * one to read — never in an empty repository, nor under `connectivityOnly`.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { fsck } from '../../../../src/application/commands/fsck.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const enc = new TextEncoder();

const repoWithConfig = async (config: string): Promise<Context> => {
  const ctx = createMemoryContext();
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, config);
  return ctx;
};

const withLooseBlob = async (ctx: Context): Promise<Context> => {
  await writeObject(ctx, { type: 'blob', id: '' as ObjectId, content: enc.encode('x\n') });
  return ctx;
};

/** The refusal `op` throws, as data; `undefined` when it resolves. */
const refusalOf = async (
  op: () => Promise<unknown>,
): Promise<Record<string, unknown> | undefined> => {
  try {
    await op();
    return undefined;
  } catch (err) {
    expect(err).toBeInstanceOf(TsgitError);
    return (err as TsgitError).data as unknown as Record<string, unknown>;
  }
};

const MALFORMED = '[core]\n\tbigFileThreshold = x\n';

describe('Given a malformed core.bigFileThreshold and a loose object', () => {
  describe.each([
    ['full', {}],
    ['no-full', { full: false }],
  ] as const)('When fsck runs %s', (_mode, opts) => {
    it('Then it refuses with CONFIG_BAD_NUMERIC_VALUE naming the key', async () => {
      // Arrange
      const ctx = await withLooseBlob(await repoWithConfig(MALFORMED));
      const sut = fsck;

      // Act
      const result = await refusalOf(() => sut(ctx, opts));

      // Assert
      expect(result).toMatchObject({
        code: 'CONFIG_BAD_NUMERIC_VALUE',
        key: 'core.bigfilethreshold',
        value: 'x',
        reason: 'invalid unit',
      });
    });
  });

  describe('When fsck runs connectivity-only', () => {
    it('Then it audits — no object content is read', async () => {
      // Arrange
      const ctx = await withLooseBlob(await repoWithConfig(MALFORMED));
      const sut = fsck;

      // Act
      const result = await refusalOf(() => sut(ctx, { connectivityOnly: true }));

      // Assert
      expect(result).toBeUndefined();
    });
  });
});

describe('Given a malformed core.bigFileThreshold and no object at all', () => {
  describe('When fsck runs', () => {
    it('Then it audits — there is nothing to read', async () => {
      // Arrange
      const ctx = await repoWithConfig(MALFORMED);
      const sut = fsck;

      // Act
      const result = await refusalOf(() => sut(ctx));

      // Assert
      expect(result).toBeUndefined();
    });
  });
});

describe('Given a malformed core.bigFileThreshold a later valid entry overrides', () => {
  describe('When fsck runs over a loose object', () => {
    it('Then it audits — git reads only the last entry', async () => {
      // Arrange
      const config = '[core]\n\tbigFileThreshold = x\n\tbigFileThreshold = 1m\n';
      const ctx = await withLooseBlob(await repoWithConfig(config));
      const sut = fsck;

      // Act
      const result = await refusalOf(() => sut(ctx));

      // Assert
      expect(result).toBeUndefined();
    });
  });
});
