import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { revParse } from '../../../../src/application/commands/rev-parse.js';
import { TsgitError } from '../../../../src/domain/index.js';
import { seedRepo } from './fixtures.js';

const TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

describe('revParse', () => {
  it('Given a non-repo ctx, When revParse(HEAD), Then throws NOT_A_REPOSITORY', async () => {
    // Arrange
    const ctx = createMemoryContext();

    // Act
    let caught: unknown;
    try {
      await revParse(ctx, 'HEAD');
    } catch (err) {
      caught = err;
    }

    // Assert
    expect(caught).toBeInstanceOf(TsgitError);
    expect((caught as TsgitError).data.code).toBe('NOT_A_REPOSITORY');
  });

  it('Given a repo with HEAD pointing to a commit ref, When revParse(HEAD), Then returns the commit oid', async () => {
    // Arrange
    const ctx = createMemoryContext();
    const { commitIds } = await seedRepo(ctx, {
      commits: [{ tree: TREE_OID, message: 'first' }],
    });
    const commitId = commitIds[0] as string;
    await seedRepo(ctx, { refs: { 'refs/heads/main': commitId } });

    // Act
    const sut = await revParse(ctx, 'HEAD');

    // Assert
    expect(sut).toBe(commitId);
  });

  it('Given a 40-hex oid, When revParse, Then returns it directly (no lookup)', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await seedRepo(ctx, {});
    const oid = '0123456789abcdef0123456789abcdef01234567';

    // Act
    const sut = await revParse(ctx, oid);

    // Assert
    expect(sut).toBe(oid);
  });

  it('Given a malformed expression, When revParse, Then throws REVPARSE_UNRESOLVED', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await seedRepo(ctx, {});

    // Act
    let caught: unknown;
    try {
      await revParse(ctx, 'HEAD~~');
    } catch (err) {
      caught = err;
    }

    // Assert
    expect(caught).toBeInstanceOf(TsgitError);
    expect((caught as TsgitError).data.code).toBe('REVPARSE_UNRESOLVED');
  });
});
