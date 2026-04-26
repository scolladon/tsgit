import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { tag } from '../../../../src/application/commands/tag.js';
import { TsgitError } from '../../../../src/domain/index.js';
import type { AuthorIdentity } from '../../../../src/domain/objects/index.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const seedWithCommit = async () => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.config.workDir}/a.txt`, 'a');
  await add(ctx, ['a.txt']);
  const c = await commit(ctx, { message: 'first', author });
  return { ctx, commitId: c.id };
};

describe('tag', () => {
  it('Given a fresh tag, When tag create, Then refs/tags/<name> exists', async () => {
    // Arrange
    const { ctx, commitId } = await seedWithCommit();

    // Act
    const sut = await tag(ctx, { kind: 'create', name: 'v1.0' });

    // Assert
    if (sut.kind !== 'create') throw new Error('expected create');
    expect(sut.id).toBe(commitId);
  });

  it('Given an existing tag, When tag create without force, Then throws TAG_EXISTS', async () => {
    // Arrange
    const { ctx } = await seedWithCommit();
    await tag(ctx, { kind: 'create', name: 'v1.0' });

    // Act
    let caught: unknown;
    try {
      await tag(ctx, { kind: 'create', name: 'v1.0' });
    } catch (err) {
      caught = err;
    }

    // Assert
    expect(caught).toBeInstanceOf(TsgitError);
    expect((caught as TsgitError).data.code).toBe('TAG_EXISTS');
  });

  it('Given a tag, When tag delete, Then ref is removed', async () => {
    // Arrange
    const { ctx } = await seedWithCommit();
    await tag(ctx, { kind: 'create', name: 'v1.0' });

    // Act
    await tag(ctx, { kind: 'delete', name: 'v1.0' });

    // Assert
    expect(await ctx.fs.exists(`${ctx.config.gitDir}/refs/tags/v1.0`)).toBe(false);
  });

  it('Given a non-existent tag, When tag delete, Then throws TAG_NOT_FOUND', async () => {
    // Arrange
    const { ctx } = await seedWithCommit();

    // Act
    let caught: unknown;
    try {
      await tag(ctx, { kind: 'delete', name: 'ghost' });
    } catch (err) {
      caught = err;
    }

    // Assert
    expect(caught).toBeInstanceOf(TsgitError);
    expect((caught as TsgitError).data.code).toBe('TAG_NOT_FOUND');
  });

  it('Given two tags, When tag list, Then returns them sorted', async () => {
    // Arrange
    const { ctx } = await seedWithCommit();
    await tag(ctx, { kind: 'create', name: 'v2.0' });
    await tag(ctx, { kind: 'create', name: 'v1.0' });

    // Act
    const sut = await tag(ctx, { kind: 'list' });

    // Assert
    if (sut.kind !== 'list') throw new Error('expected list');
    expect(sut.tags.map((t) => t.name)).toEqual(['refs/tags/v1.0', 'refs/tags/v2.0']);
  });

  it('Given an explicit target oid, When tag create, Then the tag points at that oid (not HEAD)', async () => {
    // Arrange
    const { ctx, commitId } = await seedWithCommit();

    // Act
    const sut = await tag(ctx, { kind: 'create', name: 'pin', target: commitId });

    // Assert
    if (sut.kind !== 'create') throw new Error('expected create');
    expect(sut.id).toBe(commitId);
  });

  it('Given an explicit target as a ref name, When tag create, Then resolves it via resolveRef', async () => {
    // Arrange
    const { ctx, commitId } = await seedWithCommit();

    // Act
    const sut = await tag(ctx, { kind: 'create', name: 'pin', target: 'refs/heads/main' });

    // Assert
    if (sut.kind !== 'create') throw new Error('expected create');
    expect(sut.id).toBe(commitId);
  });

  it('Given force=true on an existing tag, When tag create, Then it overwrites without throwing', async () => {
    // Arrange
    const { ctx } = await seedWithCommit();
    await tag(ctx, { kind: 'create', name: 'v1.0' });

    // Act + Assert — must not throw with force.
    await tag(ctx, { kind: 'create', name: 'v1.0', force: true });
  });

  it('Given a fresh repo with no tags, When tag list, Then returns an empty array', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await ctx.fs.writeUtf8(`${ctx.config.gitDir}/HEAD`, 'ref: refs/heads/main\n');

    // Act
    const sut = await tag(ctx, { kind: 'list' });

    // Assert
    if (sut.kind !== 'list') throw new Error('expected list');
    expect(sut.tags).toEqual([]);
  });
});
