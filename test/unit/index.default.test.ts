import { describe, expect, it } from 'vitest';

import { openRepository } from '../../src/index.default.js';

describe('memory shim — openRepository', () => {
  it('Given no options, When openRepository runs, Then it returns a frozen Repository handle', async () => {
    // Arrange
    const sut = await openRepository();

    // Assert
    expect(sut).toBeDefined();
    expect(Object.isFrozen(sut)).toBe(true);
  });

  it("Given the default cwd, When inspecting ctx, Then it equals '/repo' and the layout matches", async () => {
    // Arrange
    const sut = await openRepository();

    // Assert
    expect(sut.ctx.cwd).toBe('/repo');
    expect(sut.ctx.layout.workDir).toBe('/repo');
    expect(sut.ctx.layout.gitDir).toBe('/repo/.git');
    expect(sut.ctx.layout.bare).toBe(false);
  });

  it("Given algorithm 'sha256', When inspecting ctx.hashConfig, Then digestLength is 32 (sha256)", async () => {
    // Arrange
    const sut = await openRepository({ algorithm: 'sha256' });

    // Assert
    expect(sut.ctx.hashConfig.digestLength).toBe(32);
  });

  it('Given default algorithm, When inspecting ctx.hashConfig, Then digestLength is 20 (sha1)', async () => {
    // Arrange
    const sut = await openRepository();

    // Assert
    expect(sut.ctx.hashConfig.digestLength).toBe(20);
  });

  it('Given a files seed, When init runs, Then the .git directory is created and seeded files survive', async () => {
    // Arrange
    const seedBytes = new TextEncoder().encode('hello');
    const sut = await openRepository({
      files: { '/repo/seed.txt': seedBytes },
    });

    await sut.init();

    // Assert
    expect(await sut.ctx.fs.exists('/repo/.git/HEAD')).toBe(true);
    expect(await sut.ctx.fs.readUtf8('/repo/seed.txt')).toBe('hello');
  });

  it('Given an init via the bound method, When followed by status, Then status reports clean and on refs/heads/main', async () => {
    // Arrange
    const sut = await openRepository();

    await sut.init();
    const result = await sut.status();

    // Assert
    expect(result.clean).toBe(true);
    expect(result.branch).toBe('refs/heads/main');
  });

  it('Given a disposed repo, When any bound method is invoked, Then it throws REPOSITORY_DISPOSED', async () => {
    // Arrange
    const sut = await openRepository();
    await sut.dispose();

    try {
      await sut.init();
      // Assert
      expect.unreachable();
    } catch (err) {
      expect((err as { data: { code: string } }).data.code).toBe('REPOSITORY_DISPOSED');
    }
  });
});
