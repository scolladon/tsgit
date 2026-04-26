import { describe, expect, it } from 'vitest';

import { writeSymbolicRef } from '../../../../src/application/primitives/write-symbolic-ref.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { RefName } from '../../../../src/domain/objects/index.js';
import { buildSeededContext } from './fixtures.js';

describe('writeSymbolicRef', () => {
  it('Given name=HEAD and target=refs/heads/main, When writeSymbolicRef, Then .git/HEAD contains the documented bytes', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    const name = 'HEAD' as RefName;
    const target = 'refs/heads/main' as RefName;

    // Act
    await writeSymbolicRef(ctx, name, target);

    // Assert
    const content = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/HEAD`);
    expect(content).toBe('ref: refs/heads/main\n');
  });

  it('Given an existing direct-oid HEAD, When writeSymbolicRef, Then HEAD is overwritten as a symbolic ref', async () => {
    // Arrange
    const ctx = await buildSeededContext();
    await ctx.fs.writeUtf8(
      `${ctx.layout.gitDir}/HEAD`,
      '0123456789abcdef0123456789abcdef01234567\n',
    );

    // Act
    await writeSymbolicRef(ctx, 'HEAD' as RefName, 'refs/heads/main' as RefName);

    // Assert
    const content = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/HEAD`);
    expect(content).toBe('ref: refs/heads/main\n');
  });

  it('Given name with leading slash, When writeSymbolicRef, Then throws INVALID_REF', async () => {
    // Arrange
    const ctx = await buildSeededContext();

    // Act & Assert
    try {
      await writeSymbolicRef(ctx, '/HEAD' as RefName, 'refs/heads/main' as RefName);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TsgitError);
      expect((err as TsgitError).data.code).toBe('INVALID_REF');
    }
  });

  it('Given target with whitespace, When writeSymbolicRef, Then throws INVALID_REF', async () => {
    // Arrange
    const ctx = await buildSeededContext();

    // Act & Assert
    try {
      await writeSymbolicRef(ctx, 'HEAD' as RefName, 'refs/heads/has space' as RefName);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TsgitError);
      expect((err as TsgitError).data.code).toBe('INVALID_REF');
    }
  });
});
