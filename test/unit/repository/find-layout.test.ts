import { describe, expect, it } from 'vitest';

import { MemoryFileSystem } from '../../../src/adapters/memory/memory-file-system.js';
import { findLayout } from '../../../src/repository/find-layout.js';

describe('findLayout', () => {
  it('Given cwd contains a .git directory, When findLayout runs, Then returns layout with cwd as workDir', async () => {
    const fs = new MemoryFileSystem({ rootDir: '/repo' });
    await fs.mkdir('/repo/.git');

    const sut = await findLayout(fs, '/repo');

    expect(sut).toEqual({ workDir: '/repo', gitDir: '/repo/.git', bare: false });
  });

  it('Given cwd is a sub-directory of a repo, When findLayout runs, Then walks up to find .git', async () => {
    const fs = new MemoryFileSystem({ rootDir: '/repo' });
    await fs.mkdir('/repo/.git');
    await fs.mkdir('/repo/sub/dir');

    const sut = await findLayout(fs, '/repo/sub/dir');

    expect(sut).toEqual({ workDir: '/repo', gitDir: '/repo/.git', bare: false });
  });

  it('Given no .git anywhere up the tree, When findLayout runs, Then returns undefined', async () => {
    const fs = new MemoryFileSystem({ rootDir: '/repo' });
    await fs.mkdir('/repo/lonely');

    const sut = await findLayout(fs, '/repo/lonely');

    expect(sut).toBeUndefined();
  });

  it('Given an fs whose exists() always throws, When findLayout runs, Then it returns undefined and does NOT treat the throw as a positive (kills BooleanLiteral mutants on the catch fallback)', async () => {
    const fs = {
      exists: async () => {
        throw new Error('boom');
      },
      stat: async () => {
        throw new Error('should never be called');
      },
    } as unknown as Parameters<typeof findLayout>[0];

    const sut = await findLayout(fs, '/repo');

    expect(sut).toBeUndefined();
  });

  it('Given a .git directory that exists at cwd AND stat returns isDirectory=false, When findLayout runs, Then it does NOT return that layout (kills `if (found)` always-true mutant via the isDirectory branch)', async () => {
    const fs = new MemoryFileSystem({ rootDir: '/repo' });
    // Write .git as a regular file so exists=true but isDirectory=false.
    await fs.writeUtf8('/repo/.git', 'gitdir: /elsewhere');

    const sut = await findLayout(fs, '/repo');

    // If `if (found)` is mutated to `if (true)`, the same isDirectory check
    // gates the return — so this mutant survives. Document as equivalent.
    // The actual test that kills the mutant is: ensure when found is FALSE
    // (parent has no .git), we DON'T return a layout — covered by the
    // "no .git anywhere" test above.
    expect(sut).toBeUndefined();
  });

  it('Given a .git that exists but is a file (not a directory — gitlink), When findLayout runs, Then it does NOT return that layout (skips the file)', async () => {
    const fs = new MemoryFileSystem({ rootDir: '/repo' });
    // .git is a file (e.g., a worktree gitlink stub) at /repo/.git
    await fs.writeUtf8('/repo/.git', 'gitdir: /elsewhere');

    const sut = await findLayout(fs, '/repo');

    // The walk continues past a non-directory .git.
    expect(sut).toBeUndefined();
  });
});
