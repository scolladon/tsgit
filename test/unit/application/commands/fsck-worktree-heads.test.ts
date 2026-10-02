/**
 * git's fsck snapshots every worktree's HEAD, not only the current one: a
 * linked worktree's HEAD is named `worktrees/<id>/HEAD`, the main one seen
 * from a linked worktree `main-worktree/HEAD`. Each is a reachability root,
 * and one naming an absent object is an `invalid sha1 pointer` (bit 2).
 */
import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { type FsckFinding, fsck } from '../../../../src/application/commands/fsck.js';
import { deriveWorktreeContext } from '../../../../src/application/primitives/internal/worktree-context.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { permissionDenied } from '../../../../src/domain/error.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const ABSENT = '1111111111111111111111111111111111111111' as ObjectId;
const EXIT_MISSING = 2;
const AUTHOR = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const writeCommit = async (ctx: Context, message: string): Promise<ObjectId> => {
  const tree = await writeObject(ctx, { type: 'tree', id: '' as ObjectId, entries: [] });
  return writeObject(ctx, {
    type: 'commit',
    id: '' as ObjectId,
    data: { tree, parents: [], author: AUTHOR, committer: AUTHOR, message, extraHeaders: [] },
  });
};

/** A main repository on `main` plus linked worktrees `wt1` and `wt2`. */
const repoWithWorktrees = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  const base = await writeCommit(ctx, 'base');
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, 'ref: refs/heads/main\n');
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/heads/main`, `${base}\n`);
  for (const id of ['wt1', 'wt2']) {
    const adminDir = `${ctx.layout.gitDir}/worktrees/${id}`;
    await ctx.fs.writeUtf8(`${adminDir}/HEAD`, `${base}\n`);
    await ctx.fs.writeUtf8(`${adminDir}/gitdir`, `/work/${id}/.git\n`);
    await ctx.fs.writeUtf8(`${adminDir}/commondir`, '../..\n');
  }
  return ctx;
};

const pointerFindings = (findings: ReadonlyArray<FsckFinding>) =>
  findings.filter((finding) => finding.type === 'bad-ref' && finding.msgId === 'badRefOid');

const lostFindings = (findings: ReadonlyArray<FsckFinding>) =>
  findings.filter((finding) => finding.type === 'unreachable' || finding.type === 'dangling');

const pointer = (ref: string) => ({
  type: 'bad-ref',
  ref,
  msgId: 'badRefOid',
  severity: 'error',
  target: ABSENT,
});

describe('Given a linked worktree whose detached HEAD names an absent object', () => {
  describe('When fsck runs from the main worktree', () => {
    it('Then it reports worktrees/<id>/HEAD as an invalid pointer with bit 2', async () => {
      // Arrange
      const ctx = await repoWithWorktrees();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/worktrees/wt1/HEAD`, `${ABSENT}\n`);
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(pointerFindings(result.findings)).toEqual([pointer('worktrees/wt1/HEAD')]);
      expect(result.exitCode).toBe(EXIT_MISSING);
    });
  });

  describe('When fsck runs from that linked worktree', () => {
    it('Then it reports its own HEAD as HEAD', async () => {
      // Arrange
      const ctx = await repoWithWorktrees();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/worktrees/wt1/HEAD`, `${ABSENT}\n`);
      const sut = fsck;

      // Act
      const result = await sut(deriveWorktreeContext(ctx, 'wt1', '/work/wt1'));

      // Assert
      expect(pointerFindings(result.findings)).toEqual([pointer('HEAD')]);
      expect(result.exitCode).toBe(EXIT_MISSING);
    });
  });
});

describe('Given the main HEAD and a linked HEAD both naming an absent object', () => {
  describe('When fsck runs from another linked worktree', () => {
    it('Then it reports main-worktree/HEAD then worktrees/<id>/HEAD', async () => {
      // Arrange
      const ctx = await repoWithWorktrees();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, `${ABSENT}\n`);
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/worktrees/wt1/HEAD`, `${ABSENT}\n`);
      const sut = fsck;

      // Act
      const result = await sut(deriveWorktreeContext(ctx, 'wt2', '/work/wt2'));

      // Assert
      expect(pointerFindings(result.findings)).toEqual([
        pointer('main-worktree/HEAD'),
        pointer('worktrees/wt1/HEAD'),
      ]);
    });
  });
});

describe('Given a commit only a linked worktree HEAD names', () => {
  describe('When fsck runs from the main worktree', () => {
    it('Then the commit is reachable, never dangling', async () => {
      // Arrange
      const ctx = await repoWithWorktrees();
      const only = await writeCommit(ctx, 'only in wt2');
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/worktrees/wt2/HEAD`, `${only}\n`);
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(lostFindings(result.findings)).toEqual([]);
      expect(result.exitCode).toBe(0);
    });
  });
});

describe('Given a worktree admin directory without a gitdir file', () => {
  describe('When fsck runs', () => {
    it('Then that worktree is skipped as git skips it', async () => {
      // Arrange
      const ctx = await repoWithWorktrees();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/worktrees/stale/HEAD`, `${ABSENT}\n`);
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(pointerFindings(result.findings)).toEqual([]);
      expect(result.exitCode).toBe(0);
    });
  });
});

describe('Given a symbolic ref other than HEAD naming an unborn branch', () => {
  describe('When fsck runs', () => {
    it('Then it reports the symbolic ref as an invalid pointer to the zero oid', async () => {
      // Arrange
      const ctx = await repoWithWorktrees();
      await ctx.fs.writeUtf8(
        `${ctx.layout.gitDir}/refs/remotes/origin/HEAD`,
        'ref: refs/remotes/origin/main\n',
      );
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(pointerFindings(result.findings)).toEqual([
        { ...pointer('refs/remotes/origin/HEAD'), target: '0'.repeat(40) },
      ]);
      expect(result.exitCode).toBe(EXIT_MISSING);
    });
  });
});

describe('Given a symbolic ref other than HEAD naming a branch that names an absent object', () => {
  describe('When fsck runs', () => {
    it('Then it reports both refs, each by its own name', async () => {
      // Arrange
      const ctx = await repoWithWorktrees();
      await ctx.fs.writeUtf8(
        `${ctx.layout.gitDir}/refs/remotes/origin/HEAD`,
        'ref: refs/remotes/origin/main\n',
      );
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/refs/remotes/origin/main`, `${ABSENT}\n`);
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(pointerFindings(result.findings)).toEqual([
        pointer('refs/remotes/origin/HEAD'),
        pointer('refs/remotes/origin/main'),
      ]);
    });
  });
});

describe('Given a linked worktree whose gitdir file is empty', () => {
  describe('When fsck runs', () => {
    it('Then that worktree is skipped as git skips it', async () => {
      // Arrange
      const ctx = await repoWithWorktrees();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/worktrees/wt1/gitdir`, '');
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/worktrees/wt1/HEAD`, `${ABSENT}\n`);
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(pointerFindings(result.findings)).toEqual([]);
    });
  });
});

const failGitdirRead = (ctx: Context, fault: Error): void => {
  const gitdirPath = `${ctx.layout.gitDir}/worktrees/wt1/gitdir`;
  const readUtf8 = ctx.fs.readUtf8.bind(ctx.fs);
  vi.spyOn(ctx.fs, 'readUtf8').mockImplementation(async (path: string) => {
    if (path === gitdirPath) throw fault;
    return readUtf8(path);
  });
};

describe('Given a linked worktree whose gitdir file cannot be read for permission', () => {
  describe('When fsck runs', () => {
    it('Then that worktree is skipped as git skips it', async () => {
      // Arrange
      const ctx = await repoWithWorktrees();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/worktrees/wt1/HEAD`, `${ABSENT}\n`);
      failGitdirRead(ctx, permissionDenied(`${ctx.layout.gitDir}/worktrees/wt1/gitdir`));
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(pointerFindings(result.findings)).toEqual([]);
    });
  });
});

describe('Given a linked worktree whose gitdir read fails with an unclassified fault', () => {
  describe('When fsck runs', () => {
    it('Then the fault propagates', async () => {
      // Arrange
      const ctx = await repoWithWorktrees();
      const fault = new Error('EIO: i/o error');
      failGitdirRead(ctx, fault);
      const sut = fsck;

      // Act
      const result = sut(ctx);

      // Assert
      await expect(result).rejects.toBe(fault);
    });
  });
});

describe.each([
  {
    label: 'a cycle',
    refs: [
      ['refs/heads/a', 'ref: refs/heads/b'],
      ['refs/heads/b', 'ref: refs/heads/a'],
    ],
    broken: ['refs/heads/a', 'refs/heads/b'],
  },
  {
    label: 'a chain one symbolic hop deeper than git follows',
    refs: [
      ['refs/heads/c1', 'ref: refs/heads/c2'],
      ['refs/heads/c2', 'ref: refs/heads/c3'],
      ['refs/heads/c3', 'ref: refs/heads/c4'],
      ['refs/heads/c4', 'ref: refs/heads/c5'],
      ['refs/heads/c5', 'ref: refs/heads/c6'],
      ['refs/heads/c6', 'ref: refs/heads/main'],
    ],
    broken: ['refs/heads/c1', 'refs/heads/c2'],
  },
])('Given symbolic refs forming $label', ({ refs, broken }) => {
  describe('When fsck runs', () => {
    it('Then each ref git cannot resolve is an invalid pointer to the zero oid', async () => {
      // Arrange
      const ctx = await repoWithWorktrees();
      for (const [name, content] of refs) {
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/${name}`, `${content}\n`);
      }
      const sut = fsck;

      // Act
      const result = await sut(ctx);

      // Assert
      expect(pointerFindings(result.findings)).toEqual(
        broken.map((ref) => ({ ...pointer(ref), target: '0'.repeat(40) })),
      );
      expect(result.exitCode).toBe(EXIT_MISSING);
    });
  });
});
