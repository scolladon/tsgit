import { describe, expect, it } from 'vitest';
import { MemoryFileSystem } from '../../../src/adapters/memory/memory-file-system.js';
import { posixPolicy } from '../../../src/adapters/node/path-policy.js';
import type { LayoutProbe } from '../../../src/ports/layout-probe.js';
import { fileSystemLayoutProbe } from '../../../src/repository/file-system-layout-probe.js';
import { layoutRootsOf } from '../../../src/repository/layout-roots.js';
import { resolveLayout } from '../../../src/repository/resolve-layout.js';
import type { RepositoryLayoutInput } from '../../../src/repository.js';

// This file is load-bearing in a way no other test is: no interop row
// re-proves any of it — the ownership-trust gate runs above the first
// config byte the open sequence reads, and only a per-path recording probe
// can prove which paths were checked, in which order, and which were never
// consulted at all.

/** Marks `dir` as a valid git directory: `objects/`, `refs/`, and a `HEAD` file. */
const makeGitDir = async (fs: MemoryFileSystem, dir: string): Promise<void> => {
  await fs.mkdir(`${dir}/objects`);
  await fs.mkdir(`${dir}/refs`);
  await fs.writeUtf8(`${dir}/HEAD`, 'ref: refs/heads/main\n');
};

/** "Did readRepositoryFormat run at all" — the Stage-2 counting stub. */
const ranStage2 = (reads: ReadonlyArray<string>): boolean =>
  reads.some((path) => path.endsWith('/config'));

/**
 * Wraps `fileSystemLayoutProbe` to record every `isOwnedByCaller` query (in
 * order) and every `readUtf8` read, answering ownership per-path via
 * `owned`. The per-path answer is what makes the checked set testable — a
 * single-path predicate could not distinguish row 1 (alien gitDir, owned
 * repository path) from full trust.
 */
const recordingProbe = (
  fs: MemoryFileSystem,
  owned: (path: string) => boolean,
): { probe: LayoutProbe; ownershipQueries: string[]; reads: string[] } => {
  const base = fileSystemLayoutProbe(fs);
  const ownershipQueries: string[] = [];
  const reads: string[] = [];
  return {
    probe: {
      ...base,
      readUtf8: (path: string) => {
        reads.push(path);
        return base.readUtf8(path);
      },
      isOwnedByCaller: async (path: string) => {
        ownershipQueries.push(path);
        return owned(path);
      },
    },
    ownershipQueries,
    reads,
  };
};

/** Like `recordingProbe`, but omits `isOwnedByCaller` entirely — the capability-omitted case. */
const trackReads = (fs: MemoryFileSystem): { probe: LayoutProbe; reads: string[] } => {
  const base = fileSystemLayoutProbe(fs);
  const reads: string[] = [];
  return {
    probe: {
      ...base,
      readUtf8: (path: string) => {
        reads.push(path);
        return base.readUtf8(path);
      },
    },
    reads,
  };
};

describe('resolveLayout — the ownership-trust gate', () => {
  describe('The verdict and the checked set', () => {
    describe('Given an alien gitDir with an owned repository path, nothing allowlisted', () => {
      describe('When resolveLayout runs', () => {
        it('Then the layout carries untrusted: true — the shape a single-path predicate would admit', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/admin');
          await fs.writeUtf8('/repo/.git', 'gitdir: /repo/admin\n');
          const { probe } = recordingProbe(fs, (path) => path !== '/repo/admin');

          // Act
          const result = await resolveLayout(probe, '/repo', posixPolicy);

          // Assert
          expect(result?.untrusted).toBe(true);
          expect(result?.foreignPath).toBe('/repo/admin');
        });
      });
    });

    describe('Given an alien commonDir with an owned gitDir and repository path (linked worktree)', () => {
      describe('When resolveLayout runs at the worktree path', () => {
        it('Then the layout carries untrusted: true', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/bare.git');
          await fs.writeUtf8('/repo/bare.git/worktrees/wt/HEAD', 'ref: refs/heads/main\n');
          await fs.writeUtf8('/repo/bare.git/worktrees/wt/commondir', '../..\n');
          await fs.writeUtf8('/repo/wt/.git', 'gitdir: /repo/bare.git/worktrees/wt\n');
          const { probe } = recordingProbe(fs, (path) => path !== '/repo/bare.git');

          // Act
          const result = await resolveLayout(probe, '/repo/wt', posixPolicy);

          // Assert
          expect(result?.untrusted).toBe(true);
          expect(result?.foreignPath).toBe('/repo/bare.git');
        });
      });
    });

    describe('Given every checked path is owned, BARE_DIR route', () => {
      describe('When resolveLayout runs', () => {
        it('Then Stage 2 ran and ownershipQueries has exactly 1 entry', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/bare.git');
          await fs.writeUtf8('/repo/bare.git/config', '[core]\n');
          const { probe, ownershipQueries, reads } = recordingProbe(fs, () => true);

          // Act
          const result = await resolveLayout(probe, '/repo/bare.git', posixPolicy);

          // Assert
          expect(result?.untrusted).toBeUndefined();
          expect(ownershipQueries).toStrictEqual(['/repo/bare.git']);
          expect(ranStage2(reads)).toBe(true);
        });
      });
    });

    describe('Given every checked path is owned, normal discovery', () => {
      describe('When resolveLayout runs', () => {
        it('Then Stage 2 ran and ownershipQueries has exactly 2 entries, origin then gitDir', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/.git');
          await fs.writeUtf8('/repo/.git/config', '[core]\n');
          const { probe, ownershipQueries, reads } = recordingProbe(fs, () => true);

          // Act
          const result = await resolveLayout(probe, '/repo', posixPolicy);

          // Assert
          expect(result?.untrusted).toBeUndefined();
          expect(ownershipQueries).toStrictEqual(['/repo', '/repo/.git']);
          expect(ranStage2(reads)).toBe(true);
        });
      });
    });

    describe('Given every checked path is owned, the gitfile shape', () => {
      describe('When resolveLayout runs', () => {
        it('Then Stage 2 ran and ownershipQueries has exactly 2 entries, origin then gitDir', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/admin');
          await fs.writeUtf8('/repo/.git', 'gitdir: /repo/admin\n');
          await fs.writeUtf8('/repo/admin/config', '[core]\n');
          const { probe, ownershipQueries, reads } = recordingProbe(fs, () => true);

          // Act
          const result = await resolveLayout(probe, '/repo', posixPolicy);

          // Assert
          expect(result?.untrusted).toBeUndefined();
          expect(ownershipQueries).toStrictEqual(['/repo', '/repo/admin']);
          expect(ranStage2(reads)).toBe(true);
        });
      });
    });

    describe('Given every checked path is owned, a linked worktree', () => {
      describe('When resolveLayout runs at the worktree path', () => {
        it('Then Stage 2 ran and ownershipQueries has exactly 3 entries, in checked-set order', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/bare.git');
          await fs.writeUtf8('/repo/bare.git/worktrees/wt/HEAD', 'ref: refs/heads/main\n');
          await fs.writeUtf8('/repo/bare.git/worktrees/wt/commondir', '../..\n');
          await fs.writeUtf8('/repo/wt/.git', 'gitdir: /repo/bare.git/worktrees/wt\n');
          await fs.writeUtf8('/repo/bare.git/config', '[core]\n');
          const { probe, ownershipQueries, reads } = recordingProbe(fs, () => true);

          // Act
          const result = await resolveLayout(probe, '/repo/wt', posixPolicy);

          // Assert
          expect(result?.untrusted).toBeUndefined();
          expect(ownershipQueries).toStrictEqual([
            '/repo/wt',
            '/repo/bare.git/worktrees/wt',
            '/repo/bare.git',
          ]);
          expect(ranStage2(reads)).toBe(true);
        });
      });
    });

    describe('Given the repository path is allowlisted while every checked path is alien', () => {
      describe('When resolveLayout runs', () => {
        it('Then the layout is trusted and the ownership capability is never consulted', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/bare.git');
          await fs.writeUtf8('/repo/bare.git/config', '[core]\n');
          const { probe, ownershipQueries, reads } = recordingProbe(fs, () => false);

          // Act
          const result = await resolveLayout(probe, '/repo/bare.git', posixPolicy, {
            trustedDirectories: ['/repo/bare.git'],
          });

          // Assert
          expect(result?.untrusted).toBeUndefined();
          expect(ownershipQueries).toStrictEqual([]);
          expect(ranStage2(reads)).toBe(true);
        });
      });
    });

    describe("Given trust: 'always' while every checked path is alien", () => {
      describe('When resolveLayout runs', () => {
        it('Then the layout is trusted and the ownership capability is never consulted', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/bare.git');
          await fs.writeUtf8('/repo/bare.git/config', '[core]\n');
          const { probe, ownershipQueries, reads } = recordingProbe(fs, () => false);

          // Act
          const result = await resolveLayout(probe, '/repo/bare.git', posixPolicy, {
            trust: 'always',
          });

          // Assert
          expect(result?.untrusted).toBeUndefined();
          expect(ownershipQueries).toStrictEqual([]);
          expect(ranStage2(reads)).toBe(true);
        });
      });
    });

    describe('Given the ownership capability is omitted, on an otherwise foreign-shaped fixture', () => {
      describe('When resolveLayout runs', () => {
        it('Then the layout is trusted and Stage 2 ran', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/admin');
          await fs.writeUtf8('/repo/.git', 'gitdir: /repo/admin\n');
          await fs.writeUtf8('/repo/admin/config', '[core]\n');
          const { probe, reads } = trackReads(fs);

          // Act
          const result = await resolveLayout(probe, '/repo', posixPolicy);

          // Assert
          expect(result?.untrusted).toBeUndefined();
          expect(ranStage2(reads)).toBe(true);
        });
      });
    });

    describe("Given route === 'EXPLICIT' with alien ownership and no allowlist", () => {
      describe('When resolveLayout runs with opts.gitDir', () => {
        it('Then the layout is trusted, Stage 2 ran, and the ownership capability is never consulted', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/somewhere');
          await fs.writeUtf8('/repo/somewhere/config', '[core]\n');
          const { probe, ownershipQueries, reads } = recordingProbe(fs, () => false);

          // Act
          const result = await resolveLayout(probe, '/repo', posixPolicy, {
            gitDir: '/repo/somewhere',
          });

          // Assert
          expect(result?.untrusted).toBeUndefined();
          expect(ownershipQueries).toStrictEqual([]);
          expect(ranStage2(reads)).toBe(true);
        });
      });
    });
  });

  describe('What a refused layout does NOT read', () => {
    describe('Given an untrusted layout with a planted core.worktree = /', () => {
      describe('When resolveLayout runs', () => {
        it("Then layoutRootsOf is not ['/'], and Stage 2 did not run", async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/admin');
          await fs.writeUtf8('/repo/.git', 'gitdir: /repo/admin\n');
          await fs.writeUtf8('/repo/admin/config', '[core]\n\tworktree = /\n');
          const { probe, reads } = recordingProbe(fs, (path) => path !== '/repo/admin');

          // Act
          const result = await resolveLayout(probe, '/repo', posixPolicy);

          // Assert
          expect(result?.untrusted).toBe(true);
          expect(result).toBeDefined();
          const roots = layoutRootsOf(result as RepositoryLayoutInput);
          expect(roots).not.toStrictEqual(['/']);
          expect(ranStage2(reads)).toBe(false);
        });
      });
    });

    describe('Given an untrusted layout with a planted core.bare = banana', () => {
      describe('When resolveLayout runs', () => {
        it('Then it resolves without throwing, and Stage 2 did not run', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/admin');
          await fs.writeUtf8('/repo/.git', 'gitdir: /repo/admin\n');
          await fs.writeUtf8('/repo/admin/config', '[core]\n\tbare = banana\n');
          const { probe, reads } = recordingProbe(fs, (path) => path !== '/repo/admin');

          // Act
          const result = await resolveLayout(probe, '/repo', posixPolicy);

          // Assert
          expect(result?.untrusted).toBe(true);
          expect(ranStage2(reads)).toBe(false);
        });
      });
    });

    describe('Given an untrusted layout with a planted extensions.* selector', () => {
      describe('When resolveLayout runs', () => {
        it('Then Stage 2 did not run', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/admin');
          await fs.writeUtf8('/repo/.git', 'gitdir: /repo/admin\n');
          await fs.writeUtf8(
            '/repo/admin/config',
            '[core]\n\trepositoryformatversion = 1\n[extensions]\n\trefstorage = reftable\n',
          );
          const { probe, reads } = recordingProbe(fs, (path) => path !== '/repo/admin');

          // Act
          const result = await resolveLayout(probe, '/repo', posixPolicy);

          // Assert
          expect(result?.untrusted).toBe(true);
          expect(ranStage2(reads)).toBe(false);
        });
      });
    });
  });

  describe('The implicit-bare predicate, isolated', () => {
    describe('Given two fixtures identical but for the gitdir basename, both BARE_DIR', () => {
      describe("When resolveLayout runs with bareRepositories: 'explicit'", () => {
        it('Then only the non-.git basename carries implicitBare: true', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/wrap/.git');
          await makeGitDir(fs, '/repo/wrap2/evil.git');

          // Act
          const dotGit = await resolveLayout(
            fileSystemLayoutProbe(fs),
            '/repo/wrap/.git',
            posixPolicy,
            {
              bareRepositories: 'explicit',
            },
          );
          const evilGit = await resolveLayout(
            fileSystemLayoutProbe(fs),
            '/repo/wrap2/evil.git',
            posixPolicy,
            { bareRepositories: 'explicit' },
          );

          // Assert
          expect(dotGit?.implicitBare).toBeUndefined();
          expect(evilGit?.implicitBare).toBe(true);
        });
      });
    });

    describe('Given the same basename pair with core.bare flipped on each', () => {
      describe("When resolveLayout runs with bareRepositories: 'explicit'", () => {
        it('Then neither verdict changes', async () => {
          // Arrange — the row that kills a bareness-conditioned mutant: bareness
          // plays no part in the implicit-bare condition.
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/wrap/.git');
          await fs.writeUtf8('/repo/wrap/.git/config', '[core]\n\tbare = true\n');
          await makeGitDir(fs, '/repo/wrap2/evil.git');
          await fs.writeUtf8('/repo/wrap2/evil.git/config', '[core]\n\tbare = false\n');

          // Act
          const dotGit = await resolveLayout(
            fileSystemLayoutProbe(fs),
            '/repo/wrap/.git',
            posixPolicy,
            {
              bareRepositories: 'explicit',
            },
          );
          const evilGit = await resolveLayout(
            fileSystemLayoutProbe(fs),
            '/repo/wrap2/evil.git',
            posixPolicy,
            { bareRepositories: 'explicit' },
          );

          // Assert
          expect(dotGit?.implicitBare).toBeUndefined();
          expect(evilGit?.implicitBare).toBe(true);
        });
      });
    });

    describe('Given implicitBare with owned metadata, no allowlist, and a planted core.worktree = /', () => {
      describe("When resolveLayout runs with bareRepositories: 'explicit'", () => {
        it("Then untrusted is absent, Stage 2 did not run, and the root set is not ['/']", async () => {
          // Arrange — proves the `accepted := trusted && !implicitBare`
          // conjunction: a mutant reducing it to `trusted` alone survives
          // every other row in this file but dies here.
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/wrap/evil.git');
          await fs.writeUtf8('/repo/wrap/evil.git/config', '[core]\n\tworktree = /\n');
          const { probe, ownershipQueries, reads } = recordingProbe(fs, () => true);

          // Act
          const result = await resolveLayout(probe, '/repo/wrap/evil.git', posixPolicy, {
            bareRepositories: 'explicit',
          });

          // Assert
          expect(result?.implicitBare).toBe(true);
          expect(result?.untrusted).toBeUndefined();
          expect(ownershipQueries).toStrictEqual(['/repo/wrap/evil.git']);
          expect(result).toBeDefined();
          const roots = layoutRootsOf(result as RepositoryLayoutInput);
          expect(roots).not.toStrictEqual(['/']);
          expect(ranStage2(reads)).toBe(false);
        });
      });
    });

    describe('Given bareRepositories left at its default, on the non-.git fixture', () => {
      describe('When resolveLayout runs', () => {
        it('Then implicitBare is absent', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/wrap/evil.git');

          // Act
          const result = await resolveLayout(
            fileSystemLayoutProbe(fs),
            '/repo/wrap/evil.git',
            posixPolicy,
          );

          // Assert
          expect(result?.implicitBare).toBeUndefined();
        });
      });
    });

    describe('Given the non-.git fixture with its repository path allowlisted', () => {
      describe("When resolveLayout runs with bareRepositories: 'explicit'", () => {
        it('Then implicitBare is still set — the allowlist does not lift it', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/wrap/evil.git');

          // Act
          const result = await resolveLayout(
            fileSystemLayoutProbe(fs),
            '/repo/wrap/evil.git',
            posixPolicy,
            { bareRepositories: 'explicit', trustedDirectories: ['/repo/wrap/evil.git'] },
          );

          // Assert
          expect(result?.implicitBare).toBe(true);
        });
      });
    });

    describe("Given the non-.git fixture with trust: 'always'", () => {
      describe("When resolveLayout runs with bareRepositories: 'explicit'", () => {
        it("Then implicitBare is still set — trust: 'always' does not lift it", async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/wrap/evil.git');

          // Act
          const result = await resolveLayout(
            fileSystemLayoutProbe(fs),
            '/repo/wrap/evil.git',
            posixPolicy,
            { bareRepositories: 'explicit', trust: 'always' },
          );

          // Assert
          expect(result?.implicitBare).toBe(true);
        });
      });
    });
  });

  describe('The repository path and the foreign path', () => {
    describe('Given a deep subdirectory below a normal discovery, only the repository path alien', () => {
      describe('When resolveLayout runs', () => {
        it('Then foreignPath names the repository root', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/.git');
          await fs.mkdir('/repo/a/b/c');
          const { probe } = recordingProbe(fs, (path) => path !== '/repo');

          // Act
          const result = await resolveLayout(probe, '/repo/a/b/c', posixPolicy);

          // Assert
          expect(result?.foreignPath).toBe('/repo');
        });
      });
    });

    describe('Given a .git-file work tree, only the repository path alien', () => {
      describe('When resolveLayout runs', () => {
        it('Then foreignPath names the work tree, not the pointed-at gitdir', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/admin');
          await fs.writeUtf8('/repo/.git', 'gitdir: /repo/admin\n');
          const { probe } = recordingProbe(fs, (path) => path !== '/repo');

          // Act
          const result = await resolveLayout(probe, '/repo', posixPolicy);

          // Assert
          expect(result?.foreignPath).toBe('/repo');
        });
      });
    });

    describe('Given a linked worktree, only the repository path alien', () => {
      describe('When resolveLayout runs at the worktree path', () => {
        it('Then foreignPath names the worktree dir, not the common dir', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/bare.git');
          await fs.writeUtf8('/repo/bare.git/worktrees/wt/HEAD', 'ref: refs/heads/main\n');
          await fs.writeUtf8('/repo/bare.git/worktrees/wt/commondir', '../..\n');
          await fs.writeUtf8('/repo/wt/.git', 'gitdir: /repo/bare.git/worktrees/wt\n');
          const { probe } = recordingProbe(fs, (path) => path !== '/repo/wt');

          // Act
          const result = await resolveLayout(probe, '/repo/wt', posixPolicy);

          // Assert
          expect(result?.foreignPath).toBe('/repo/wt');
        });
      });
    });

    describe('Given a bare gitdir entered directly, only the repository path alien', () => {
      describe('When resolveLayout runs at the gitdir itself', () => {
        it('Then foreignPath names the gitdir', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/bare.git');
          const { probe } = recordingProbe(fs, (path) => path !== '/repo/bare.git');

          // Act
          const result = await resolveLayout(probe, '/repo/bare.git', posixPolicy);

          // Assert
          expect(result?.foreignPath).toBe('/repo/bare.git');
        });
      });
    });

    describe('Given a .git directory entered directly, only the repository path alien', () => {
      describe('When resolveLayout runs at the .git directory itself', () => {
        it('Then foreignPath names the gitdir', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/.git');
          const { probe } = recordingProbe(fs, (path) => path !== '/repo/.git');

          // Act
          const result = await resolveLayout(probe, '/repo/.git', posixPolicy);

          // Assert
          expect(result?.foreignPath).toBe('/repo/.git');
        });
      });
    });

    describe('Given exactly one checked path foreign, and it is not the repository path', () => {
      describe('When resolveLayout runs', () => {
        it('Then foreignPath names that path', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/admin');
          await fs.writeUtf8('/repo/.git', 'gitdir: /repo/admin\n');
          const { probe } = recordingProbe(fs, (path) => path !== '/repo/admin');

          // Act
          const result = await resolveLayout(probe, '/repo', posixPolicy);

          // Assert
          expect(result?.foreignPath).toBe('/repo/admin');
        });
      });
    });

    describe('Given the repository path itself is foreign, everything else owned', () => {
      describe('When resolveLayout runs', () => {
        it('Then foreignPath equals the repository path — the tier omits it later, the layout still carries it', async () => {
          // Arrange
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/.git');
          const { probe } = recordingProbe(fs, (path) => path !== '/repo');

          // Act
          const result = await resolveLayout(probe, '/repo', posixPolicy);

          // Assert
          expect(result?.foreignPath).toBe('/repo');
        });
      });
    });

    describe('Given two checked paths foreign — the repository path and the common dir', () => {
      describe('When resolveLayout runs at the worktree path', () => {
        it('Then foreignPath names the repository path, first in the documented check order', async () => {
          // Arrange — chosen so the two candidates are distinguishable: if the
          // check order were reversed, foreignPath would name the common dir
          // instead. Written off the documented order, not the implementation's
          // array, so a reordering mutant dies here.
          const fs = new MemoryFileSystem({ rootDir: '/repo' });
          await makeGitDir(fs, '/repo/bare.git');
          await fs.writeUtf8('/repo/bare.git/worktrees/wt/HEAD', 'ref: refs/heads/main\n');
          await fs.writeUtf8('/repo/bare.git/worktrees/wt/commondir', '../..\n');
          await fs.writeUtf8('/repo/wt/.git', 'gitdir: /repo/bare.git/worktrees/wt\n');
          const admin = '/repo/bare.git/worktrees/wt';
          const { probe, ownershipQueries } = recordingProbe(fs, (path) => path === admin);

          // Act
          const result = await resolveLayout(probe, '/repo/wt', posixPolicy);

          // Assert
          expect(result?.foreignPath).toBe('/repo/wt');
          expect(ownershipQueries).toStrictEqual(['/repo/wt']);
        });
      });
    });
  });
});
