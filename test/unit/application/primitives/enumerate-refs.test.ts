import { describe, expect, it } from 'vitest';
import { enumerateRefs } from '../../../../src/application/primitives/enumerate-refs.js';
import type { ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import { buildSeededContext } from './fixtures.js';

const OID_A = 'a'.repeat(40) as ObjectId;
const OID_B = 'b'.repeat(40) as ObjectId;
const OID_C = 'c'.repeat(40) as ObjectId;

describe('enumerateRefs', () => {
  describe('Given a repo with only HEAD', () => {
    describe('When enumerateRefs', () => {
      it('Then returns just HEAD', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');

        // Act
        const result = await enumerateRefs(ctx);

        // Assert
        expect(result).toEqual(['HEAD']);
      });
    });
  });

  describe('Given no HEAD file', () => {
    describe('When enumerateRefs', () => {
      it('Then HEAD is not included', async () => {
        // Arrange
        const ctx = await buildSeededContext();

        // Act
        const result = await enumerateRefs(ctx);

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given loose refs under refs/**', () => {
    describe('When enumerateRefs', () => {
      it('Then every loose ref is returned', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          refs: [
            { name: 'refs/heads/main' as RefName, id: OID_A },
            { name: 'refs/remotes/origin/main' as RefName, id: OID_B },
          ],
        });
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');

        // Act
        const result = await enumerateRefs(ctx);

        // Assert
        expect([...result].sort()).toEqual(
          ['HEAD', 'refs/heads/main', 'refs/remotes/origin/main'].sort(),
        );
      });
    });
  });

  describe('Given packed-refs entries', () => {
    describe('When enumerateRefs', () => {
      it('Then packed refs are included', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          packedRefs: [{ name: 'refs/tags/v1.0.0' as RefName, id: OID_C }],
        });

        // Act
        const result = await enumerateRefs(ctx);

        // Assert
        expect(result).toContain('refs/tags/v1.0.0');
      });
    });
  });

  describe('Given a ref present both loose and packed', () => {
    describe('When enumerateRefs', () => {
      it('Then it appears exactly once', async () => {
        // Arrange
        const ctx = await buildSeededContext({
          refs: [{ name: 'refs/heads/main' as RefName, id: OID_A }],
          packedRefs: [{ name: 'refs/heads/main' as RefName, id: OID_B }],
        });

        // Act
        const result = await enumerateRefs(ctx);

        // Assert
        expect(result.filter((r) => r === 'refs/heads/main')).toHaveLength(1);
      });
    });
  });
});
