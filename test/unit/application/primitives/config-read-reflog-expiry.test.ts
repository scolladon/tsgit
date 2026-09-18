import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { readReflogExpiryConfig } from '../../../../src/application/primitives/config-read.js';
import type { Context } from '../../../../src/ports/context.js';

const seed = async (ctx: Context, content: string): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, content);
};

describe('readReflogExpiryConfig', () => {
  describe('Given no [gc] section at all', () => {
    describe('When reading', () => {
      it('Then it returns an empty list', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n\tbare = false\n');

        // Act
        const result = await readReflogExpiryConfig(ctx);

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given a subsectionless [gc] entry', () => {
    describe('When reading', () => {
      it('Then it reports an undefined pattern and the lowercased key', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[gc]\n\treflogExpire = 30.days.ago\n');

        // Act
        const result = await readReflogExpiryConfig(ctx);

        // Assert
        expect(result).toEqual([
          {
            pattern: undefined,
            slot: 'total',
            value: '30.days.ago',
            key: 'gc.reflogexpire',
            source: `${ctx.layout.gitDir}/config`,
            line: 2,
          },
        ]);
      });
    });
  });

  describe('Given a reflogExpireUnreachable entry', () => {
    describe('When reading', () => {
      it('Then the slot is unreachable', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[gc]\n\treflogExpireUnreachable = never\n');

        // Act
        const result = await readReflogExpiryConfig(ctx);

        // Assert
        expect(result).toEqual([
          {
            pattern: undefined,
            slot: 'unreachable',
            value: 'never',
            key: 'gc.reflogexpireunreachable',
            source: `${ctx.layout.gitDir}/config`,
            line: 2,
          },
        ]);
      });
    });
  });

  describe('Given a [gc "<pattern>"] entry', () => {
    describe('When reading', () => {
      it('Then the pattern and case are kept verbatim, only the key is lowercased', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[gc "refs/Heads/*"]\n\treflogExpire = never\n');

        // Act
        const result = await readReflogExpiryConfig(ctx);

        // Assert
        expect(result).toEqual([
          {
            pattern: 'refs/Heads/*',
            slot: 'total',
            value: 'never',
            key: 'gc.refs/Heads/*.reflogexpire',
            source: `${ctx.layout.gitDir}/config`,
            line: 2,
          },
        ]);
      });
    });
  });

  describe('Given a valueless entry', () => {
    describe('When reading', () => {
      it('Then value is null', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[gc]\n\treflogExpire\n');

        // Act
        const result = await readReflogExpiryConfig(ctx);

        // Assert
        expect(result[0]?.value).toBeNull();
      });
    });
  });

  describe('Given unrelated [gc] keys and other sections', () => {
    describe('When reading', () => {
      it('Then only reflogExpire[Unreachable] entries are reported', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(
          ctx,
          '[gc]\n\tauto = 256\n\treflogExpire = 30.days.ago\n[core]\n\treflogExpire = ignored\n',
        );

        // Act
        const result = await readReflogExpiryConfig(ctx);

        // Assert
        expect(result).toHaveLength(1);
        expect(result[0]?.key).toBe('gc.reflogexpire');
      });
    });
  });

  describe('Given a [gc] section carrying a comment line and a blank line, then an uppercase [GC] header', () => {
    describe('When reading', () => {
      it('Then the comment and blank lines are skipped and the uppercase section still counts', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(
          ctx,
          '[gc]\n\t# keep reflogs\n\n\treflogExpire = never\n[GC]\n\treflogExpireUnreachable = now\n',
        );

        // Act
        const result = await readReflogExpiryConfig(ctx);

        // Assert
        expect(result).toEqual([
          {
            pattern: undefined,
            slot: 'total',
            value: 'never',
            key: 'gc.reflogexpire',
            source: `${ctx.layout.gitDir}/config`,
            line: 4,
          },
          {
            pattern: undefined,
            slot: 'unreachable',
            value: 'now',
            key: 'gc.reflogexpireunreachable',
            source: `${ctx.layout.gitDir}/config`,
            line: 6,
          },
        ]);
      });
    });
  });

  describe('Given entries across multiple [gc] sections, in file order', () => {
    describe('When reading', () => {
      it('Then every entry is returned with its own 1-based line', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(
          ctx,
          '[gc]\n\treflogExpire = 30.days.ago\n[gc "refs/heads/*"]\n\treflogExpireUnreachable = 45.days.ago\n',
        );

        // Act
        const result = await readReflogExpiryConfig(ctx);

        // Assert
        expect(result.map((entry) => entry.line)).toEqual([2, 4]);
        expect(result.map((entry) => entry.pattern)).toEqual([undefined, 'refs/heads/*']);
      });
    });
  });
});
