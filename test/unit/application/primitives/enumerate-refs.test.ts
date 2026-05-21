import { describe, expect, it } from 'vitest';
import { enumerateRefs } from '../../../../src/application/primitives/enumerate-refs.js';
import type { ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import { buildSeededContext } from './fixtures.js';

const OID_A = 'a'.repeat(40) as ObjectId;
const OID_B = 'b'.repeat(40) as ObjectId;
const OID_C = 'c'.repeat(40) as ObjectId;

describe('enumerateRefs', () => {
  it('Given a repo with only HEAD, When enumerateRefs, Then returns just HEAD', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');

    // Act
    const result = await enumerateRefs(ctx);

    // Assert
    expect(result).toEqual(['HEAD']);
  });

  it('Given no HEAD file, When enumerateRefs, Then HEAD is not included', async () => {
    // Arrange
    const ctx = await buildSeededContext();

    // Act
    const result = await enumerateRefs(ctx);

    // Assert
    expect(result).toEqual([]);
  });

  it('Given loose refs under refs/**, When enumerateRefs, Then every loose ref is returned', async () => {
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

  it('Given packed-refs entries, When enumerateRefs, Then packed refs are included', async () => {
    // Arrange
    const ctx = await buildSeededContext({
      packedRefs: [{ name: 'refs/tags/v1.0.0' as RefName, id: OID_C }],
    });

    // Act
    const result = await enumerateRefs(ctx);

    // Assert
    expect(result).toContain('refs/tags/v1.0.0');
  });

  it('Given a ref present both loose and packed, When enumerateRefs, Then it appears exactly once', async () => {
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
