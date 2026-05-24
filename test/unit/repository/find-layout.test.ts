import { describe, expect, it } from 'vitest';
import { MemoryFileSystem } from '../../../src/adapters/memory/memory-file-system.js';
import { posixPolicy } from '../../../src/adapters/node/path-policy.js';
import { findLayout } from '../../../src/repository/find-layout.js';

// All tests use POSIX paths with the in-memory FS (which is POSIX-only by
// design) and inject `posixPolicy` so the walk stays POSIX-rooted on any
// host. The production `findLayout` uses `nativePolicy` (host-matching)
// when invoked without a policy argument — covered by the integration
// tests in the cross-platform suite.

describe('findLayout', () => {
  it('Given cwd contains a .git directory, When findLayout runs, Then returns layout with cwd as workDir', async () => {
    // Arrange
    const fs = new MemoryFileSystem({ rootDir: '/repo' });
    await fs.mkdir('/repo/.git');

    const sut = await findLayout(fs, '/repo', posixPolicy);

    // Assert
    expect(sut).toEqual({ workDir: '/repo', gitDir: '/repo/.git', bare: false });
  });

  it('Given cwd is a sub-directory of a repo, When findLayout runs, Then walks up to find .git', async () => {
    // Arrange
    const fs = new MemoryFileSystem({ rootDir: '/repo' });
    await fs.mkdir('/repo/.git');
    await fs.mkdir('/repo/sub/dir');

    const sut = await findLayout(fs, '/repo/sub/dir', posixPolicy);

    // Assert
    expect(sut).toEqual({ workDir: '/repo', gitDir: '/repo/.git', bare: false });
  });

  it('Given no .git anywhere up the tree, When findLayout runs, Then returns undefined', async () => {
    // Arrange
    const fs = new MemoryFileSystem({ rootDir: '/repo' });
    await fs.mkdir('/repo/lonely');

    const sut = await findLayout(fs, '/repo/lonely', posixPolicy);

    // Assert
    expect(sut).toBeUndefined();
  });

  it('Given an fs whose exists() always throws, When findLayout runs, Then it returns undefined and does NOT treat the throw as a positive (kills BooleanLiteral mutants on the catch fallback)', async () => {
    // Arrange
    const fs = {
      exists: async () => {
        throw new Error('boom');
      },
      stat: async () => {
        throw new Error('should never be called');
      },
    } as unknown as Parameters<typeof findLayout>[0];

    const sut = await findLayout(fs, '/repo', posixPolicy);

    // Assert
    expect(sut).toBeUndefined();
  });

  it('Given a .git that exists but is a file (not a directory — gitlink), When findLayout runs, Then it does NOT return that layout (skips the file)', async () => {
    // Arrange
    const fs = new MemoryFileSystem({ rootDir: '/repo' });
    // .git is a file (e.g., a worktree gitlink stub) at /repo/.git
    await fs.writeUtf8('/repo/.git', 'gitdir: /elsewhere');

    const sut = await findLayout(fs, '/repo', posixPolicy);

    // The walk continues past a non-directory .git. This also documents
    // an equivalent mutant: flipping `if (found)` to `if (true)` keeps
    // the inner `isDirectory` check that gates the return, so the
    // observable behaviour is identical.
    // Assert
    expect(sut).toBeUndefined();
  });
});
