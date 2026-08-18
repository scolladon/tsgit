import { describe, expect, it } from 'vitest';
import { TsgitError } from '../../../src/domain/error.js';
import { openRepository } from '../../../src/index.default.js';

// The memory shim (`src/index.default.ts`) is outside the coverage include
// list and has no integration home, but wiring real discovery into it is a
// real behavioural change — these are unit tests of that shim, not test
// infra.

const encode = (content: string): Uint8Array => new TextEncoder().encode(content);
const SEED_OID = '0'.repeat(40);

/** A worktree admin dir + linked worktree, wholly inside the sandboxed `/repo` root. */
const worktreeFiles = {
  '/repo/.git/HEAD': encode('ref: refs/heads/main\n'),
  '/repo/.git/refs/heads/main': encode(`${SEED_OID}\n`),
  '/repo/.git/objects/info/packs': encode(''),
  '/repo/.git/worktrees/wt/HEAD': encode('ref: refs/heads/wt\n'),
  '/repo/.git/worktrees/wt/commondir': encode('../..\n'),
  '/repo/.git/worktrees/wt/gitdir': encode('/repo/wt/.git\n'),
  '/repo/wt/.git': encode('gitdir: /repo/.git/worktrees/wt\n'),
};

describe('openRepository (memory shim) — layout discovery', () => {
  describe('Given a memory FS seeded with a worktree admin dir wholly inside /repo', () => {
    describe('When openRepository runs with cwd at the worktree path', () => {
      it('Then ctx.layout resolves the worktree gitdir and the shared commonDir', async () => {
        // Arrange & Act
        const sut = await openRepository({ cwd: '/repo/wt', files: worktreeFiles });

        // Assert
        expect(sut.ctx.layout.gitDir).toBe('/repo/.git/worktrees/wt');
        expect(sut.ctx.layout.commonDir).toBe('/repo/.git');
      });
    });
  });

  describe('Given a memory FS seeded with a plain .git directory at /repo', () => {
    describe('When openRepository runs with the default cwd', () => {
      it('Then ctx.layout matches the discovered repo with no commonDir key', async () => {
        // Arrange
        const files = {
          '/repo/.git/HEAD': encode('ref: refs/heads/main\n'),
          '/repo/.git/refs/heads/main': encode(`${SEED_OID}\n`),
          '/repo/.git/objects/info/packs': encode(''),
        };

        // Act
        const sut = await openRepository({ files });

        // Assert
        expect(sut.ctx.layout).toStrictEqual({
          workDir: '/repo',
          gitDir: '/repo/.git',
          bare: false,
        });
      });
    });
  });

  describe('Given an empty memory FS', () => {
    describe('When openRepository runs with no files seed', () => {
      it('Then ctx.layout falls back to the hardcoded default', async () => {
        // Arrange & Act
        const sut = await openRepository();

        // Assert
        expect(sut.ctx.layout).toStrictEqual({
          workDir: '/repo',
          gitDir: '/repo/.git',
          bare: false,
        });
      });
    });
  });

  describe('Given a memory FS seeded with a bare layout wholly inside /repo', () => {
    describe('When openRepository runs with the default cwd', () => {
      it('Then ctx.layout resolves gitDir === /repo, no workDir, bare === true', async () => {
        // Arrange — the memory half of the cross-adapter proof: cwd-is-gitdir
        // discovery plus config-driven bareness, exactly like the node shim.
        const files = {
          '/repo/HEAD': encode('ref: refs/heads/main\n'),
          '/repo/refs/heads/main': encode(`${SEED_OID}\n`),
          '/repo/objects/info/packs': encode(''),
          '/repo/config': encode('[core]\n\tbare = true\n'),
        };

        // Act
        const sut = await openRepository({ files });

        // Assert
        expect(sut.ctx.layout).toStrictEqual({ gitDir: '/repo', bare: true });
      });
    });
  });

  describe('Given a worktree gitfile pointing at an admin dir outside the sandbox root', () => {
    describe('When openRepository runs with cwd at the worktree path', () => {
      it('Then it throws NOT_A_REPOSITORY naming the worktree dir', async () => {
        // Arrange
        const files = { '/repo/wt/.git': encode('gitdir: /outside/admin\n') };

        // Act
        let caught: unknown;
        try {
          await openRepository({ cwd: '/repo/wt', files });
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({
          code: 'NOT_A_REPOSITORY',
          path: '/repo/wt',
        });
      });
    });
  });
});
