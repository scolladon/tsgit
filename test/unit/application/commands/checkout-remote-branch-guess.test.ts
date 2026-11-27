/**
 * git's remote-branch guess for `checkout <name>`: a name no revision answers,
 * mapped by a remote's fetch refspec onto a remote-tracking ref that resolves,
 * is checked out as `checkout -b <name> <that ref>` would check it out.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { resolveRevisionExpression } from '../../../../src/application/commands/internal/revision-expression.js';
import { __resetConfigCacheForTests } from '../../../../src/application/primitives/config-read.js';
import { readReflog } from '../../../../src/application/primitives/reflog-store.js';
import { refResolvesForReading } from '../../../../src/application/primitives/resolve-ref.js';
import { updateRef } from '../../../../src/application/primitives/update-ref.js';
import { writeSymbolicRef } from '../../../../src/application/primitives/write-symbolic-ref.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { AuthorIdentity, ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const ORIGIN = '[remote "origin"]\n\turl = /up\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n';
const ORIGIN_FEAT = 'refs/remotes/origin/feat' as RefName;
const FEAT = 'refs/heads/feat' as RefName;
const FEAT_SECTION = '[branch "feat"]\n\tremote = origin\n\tmerge = refs/heads/feat\n';

interface Seeded {
  readonly ctx: Context;
  readonly first: ObjectId;
  readonly second: ObjectId;
}

/**
 * `main` at `first` (a.txt); `origin/feat` at `second`, which adds f.txt; the
 * origin remote configured, plus `config`.
 */
const seed = async (config = ''): Promise<Seeded> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await writeSymbolicRef(ctx, 'HEAD' as RefName, 'refs/heads/main' as RefName);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
  await add(ctx, ['a.txt']);
  const first = (await commit(ctx, { message: 'first', author: AUTHOR })).id;
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/f.txt`, 'f');
  await add(ctx, ['f.txt']);
  const second = (await commit(ctx, { message: 'second', author: AUTHOR })).id;
  await updateRef(ctx, ORIGIN_FEAT, second, { reflogMessage: 'plant' });
  await updateRef(ctx, 'refs/heads/main' as RefName, first, { reflogMessage: 'rewind' });
  await checkout(ctx, { rev: 'main', force: true });
  await appendConfig(ctx, `${ORIGIN}${config}`);
  return { ctx, first, second };
};

const configPathOf = (ctx: Context): string => `${ctx.layout.gitDir}/config`;

const appendConfig = async (ctx: Context, text: string): Promise<void> => {
  const config = await ctx.fs.readUtf8(configPathOf(ctx));
  await ctx.fs.writeUtf8(configPathOf(ctx), `${config}${text}`);
  __resetConfigCacheForTests();
};

/** HEAD on a branch nothing was ever committed to, with no index and no tracked file. */
const unborn = async (ctx: Context): Promise<void> => {
  await writeSymbolicRef(ctx, 'HEAD' as RefName, 'refs/heads/unborn' as RefName);
  await ctx.fs.rm(`${ctx.layout.gitDir}/index`);
  await ctx.fs.rm(`${ctx.layout.workDir}/a.txt`);
};

const headFile = (ctx: Context): Promise<string> => ctx.fs.readUtf8(`${ctx.layout.gitDir}/HEAD`);

const branchSection = async (ctx: Context, name: string): Promise<string | undefined> => {
  const config = await ctx.fs.readUtf8(configPathOf(ctx));
  const header = `[branch "${name}"]\n`;
  const at = config.indexOf(header);
  if (at < 0) return undefined;
  const next = config.indexOf('\n[', at + header.length);
  return config.slice(at, next < 0 ? undefined : next + 1);
};

const lastReflogMessage = async (ctx: Context, ref: string): Promise<string | undefined> =>
  (await readReflog(ctx, ref as RefName)).at(-1)?.message;

const refusalOf = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    return (error as TsgitError).data;
  }
  return undefined;
};

describe('checkout remote-branch guess', () => {
  describe('Given a name only a remote-tracking ref carries', () => {
    describe('When checkout switches to the name', () => {
      it('Then the local branch is created tracking the remote and HEAD attaches to it', async () => {
        // Arrange
        const { ctx, second } = await seed();
        const sut = checkout;

        // Act
        const result = await sut(ctx, { rev: 'feat' });

        // Assert
        expect(result).toMatchObject({ branch: FEAT, id: second, detached: false });
        expect(result.createdBranch).toEqual({
          name: FEAT,
          id: second,
          upstream: { remote: 'origin', merges: [FEAT], rebase: false },
        });
        expect(await headFile(ctx)).toBe('ref: refs/heads/feat\n');
        expect(await branchSection(ctx, 'feat')).toBe(FEAT_SECTION);
        expect(await lastReflogMessage(ctx, FEAT)).toBe(
          'branch: Created from refs/remotes/origin/feat',
        );
        expect(await lastReflogMessage(ctx, 'HEAD')).toBe('checkout: moving from main to feat');
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/f.txt`)).toBe('f');
      });
    });

    describe('When checkout switches to the name with the guess turned off', () => {
      it('Then no branch is guessed and the name is an unmatched pathspec', async () => {
        // Arrange
        const { ctx } = await seed();
        const sut = checkout;

        // Act
        const result = await refusalOf(() => sut(ctx, { rev: 'feat', guess: false }));

        // Assert
        expect(result).toEqual({ code: 'PATHSPEC_NO_MATCH', pattern: 'feat', patterns: ['feat'] });
        expect(await refResolvesForReading(ctx, FEAT)).toBe(false);
        expect(await headFile(ctx)).toBe('ref: refs/heads/main\n');
      });
    });

    describe('When checkout creates a branch from the name with the guess turned on', () => {
      it('Then no guess is made and the start point is refused', async () => {
        // Arrange
        const { ctx } = await seed();
        const sut = checkout;

        // Act
        const result = await refusalOf(() =>
          sut(ctx, { rev: 'feat', guess: true, createBranch: { name: 'x' } }),
        );

        // Assert
        expect(result).toEqual({
          code: 'CHECKOUT_START_POINT_NOT_COMMIT',
          revision: 'feat',
          branch: 'x',
        });
        expect(await refResolvesForReading(ctx, FEAT)).toBe(false);
      });
    });
  });

  describe('Given an unborn HEAD and a name only a remote-tracking ref carries', () => {
    describe('When checkout switches to the name', () => {
      it('Then the branch is created and HEAD attaches to it', async () => {
        // Arrange
        const { ctx } = await seed();
        await unborn(ctx);
        const sut = checkout;

        // Act
        await sut(ctx, { rev: 'feat' });

        // Assert
        expect(await headFile(ctx)).toBe('ref: refs/heads/feat\n');
        expect(await branchSection(ctx, 'feat')).toBe(FEAT_SECTION);
        expect(await lastReflogMessage(ctx, FEAT)).toBe(
          'branch: Created from refs/remotes/origin/feat',
        );
      });
    });
  });

  describe('Given a detached HEAD and a name only a remote-tracking ref carries', () => {
    describe('When checkout switches to the name', () => {
      it('Then the HEAD reflog moves from the full object id to the name', async () => {
        // Arrange
        const { ctx, first } = await seed();
        await checkout(ctx, { rev: first, detach: true });
        const sut = checkout;

        // Act
        await sut(ctx, { rev: 'feat' });

        // Assert
        expect(await headFile(ctx)).toBe('ref: refs/heads/feat\n');
        expect(await lastReflogMessage(ctx, 'HEAD')).toBe(`checkout: moving from ${first} to feat`);
      });
    });
  });

  describe('Given a dirty tracked file and a name only a remote-tracking ref carries', () => {
    describe('When a forced checkout switches to the name', () => {
      it('Then the branch is guessed and the file reset', async () => {
        // Arrange
        const { ctx } = await seed();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'dirty');
        const sut = checkout;

        // Act
        await sut(ctx, { rev: 'feat', force: true });

        // Assert
        expect(await headFile(ctx)).toBe('ref: refs/heads/feat\n');
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/a.txt`)).toBe('a');
      });
    });
  });

  describe.each([
    { label: 'a valueless checkout.guess', config: '[checkout]\n\tguess\n' },
    {
      label: 'checkout.guess false then true',
      config: '[checkout]\n\tguess = false\n\tguess = true\n',
    },
  ])('Given $label and a name only a remote-tracking ref carries', ({ config }) => {
    describe('When checkout switches to the name', () => {
      it('Then the branch is guessed', async () => {
        // Arrange
        const { ctx } = await seed(config);
        const sut = checkout;

        // Act
        await sut(ctx, { rev: 'feat' });

        // Assert
        expect(await headFile(ctx)).toBe('ref: refs/heads/feat\n');
      });
    });
  });

  describe('Given a name only a remote-tracking ref carries and HEAD on main', () => {
    describe('When checkout switches to the name with detach', () => {
      it('Then it refuses the detach conflict and creates nothing', async () => {
        // Arrange
        const { ctx } = await seed();
        const sut = checkout;

        // Act
        const result = await refusalOf(() => sut(ctx, { rev: 'feat', detach: true }));

        // Assert
        expect(result).toEqual({
          code: 'INVALID_OPTION',
          option: 'createBranch',
          reason: 'cannot be combined with detach',
        });
        expect(await refResolvesForReading(ctx, FEAT)).toBe(false);
        expect(await headFile(ctx)).toBe('ref: refs/heads/main\n');
      });
    });
  });

  describe('Given an unborn HEAD and a remote-tracking HEAD', () => {
    describe.each([
      { label: 'HEAD', opts: { rev: 'HEAD' } },
      { label: 'HEAD with detach', opts: { rev: 'HEAD', detach: true } },
    ])('When checkout switches to $label', ({ opts }) => {
      it('Then it refuses HEAD as a branch name and creates nothing', async () => {
        // Arrange
        const { ctx } = await seed();
        await writeSymbolicRef(ctx, 'refs/remotes/origin/HEAD' as RefName, ORIGIN_FEAT);
        await unborn(ctx);
        const sut = checkout;

        // Act
        const result = await refusalOf(() => sut(ctx, opts));

        // Assert
        expect(result).toEqual({ code: 'INVALID_REF', reason: 'branch name must not be HEAD' });
        expect(await headFile(ctx)).toBe('ref: refs/heads/unborn\n');
      });
    });
  });

  describe('Given a remote-tracking ref naming a tree', () => {
    describe('When checkout switches to its name', () => {
      it('Then it refuses the non-commit, naming the mapped ref', async () => {
        // Arrange
        const { ctx } = await seed();
        const tree = await resolveRevisionExpression(ctx, 'HEAD^{tree}');
        await updateRef(ctx, 'refs/remotes/origin/treeish' as RefName, tree as ObjectId, {
          reflogMessage: 'plant',
        });
        const sut = checkout;

        // Act
        const result = await refusalOf(() => sut(ctx, { rev: 'treeish' }));

        // Assert
        expect(result).toEqual({
          code: 'CHECKOUT_NON_COMMIT',
          revision: 'refs/remotes/origin/treeish',
        });
        expect(await refResolvesForReading(ctx, 'refs/heads/treeish' as RefName)).toBe(false);
      });
    });
  });

  describe('Given a second remote mapping onto the same tracking ref and origin as default', () => {
    describe('When checkout switches to the name', () => {
      it('Then the branch is written, tracking is refused as ambiguous and HEAD stays', async () => {
        // Arrange
        const { ctx, second } = await seed(
          '[remote "other"]\n\turl = /other\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[checkout]\n\tdefaultRemote = origin\n',
        );
        const sut = checkout;

        // Act
        const result = await refusalOf(() => sut(ctx, { rev: 'feat' }));

        // Assert
        expect(result).toEqual({
          code: 'TRACKING_AMBIGUOUS',
          ref: ORIGIN_FEAT,
          remotes: ['origin', 'other'],
        });
        expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/refs/heads/feat`)).toBe(`${second}\n`);
        expect(await headFile(ctx)).toBe('ref: refs/heads/main\n');
      });
    });
  });

  describe('Given a staged file the guessed branch would overwrite', () => {
    describe('When checkout switches to the name', () => {
      it('Then it refuses the local change and writes no branch', async () => {
        // Arrange
        const { ctx } = await seed();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/f.txt`, 'local');
        await add(ctx, ['f.txt']);
        const sut = checkout;

        // Act
        const result = await refusalOf(() => sut(ctx, { rev: 'feat' }));

        // Assert
        expect(result).toEqual({
          code: 'CHECKOUT_OVERWRITE_DIRTY',
          localChanges: ['f.txt'],
          untracked: [],
        });
        expect(await refResolvesForReading(ctx, FEAT)).toBe(false);
        expect(await headFile(ctx)).toBe('ref: refs/heads/main\n');
      });
    });
  });

  describe('Given a name with revision syntax the mapped ref resolves through', () => {
    describe('When checkout switches to the name', () => {
      it('Then it refuses the name as a branch name and creates nothing', async () => {
        // Arrange
        const { ctx } = await seed();
        const sut = checkout;

        // Act
        const result = await refusalOf(() => sut(ctx, { rev: 'feat~1' }));

        // Assert
        expect(result).toEqual({
          code: 'INVALID_REF',
          reason: 'ref name contains forbidden character',
        });
        expect(await headFile(ctx)).toBe('ref: refs/heads/main\n');
      });
    });
  });

  describe('Given checkout.guess false and a name only a remote-tracking ref carries', () => {
    describe('When checkout switches to the name', () => {
      it('Then no branch is guessed and the name is an unmatched pathspec', async () => {
        // Arrange
        const { ctx } = await seed('[checkout]\n\tguess = false\n');
        const sut = checkout;

        // Act
        const result = await refusalOf(() => sut(ctx, { rev: 'feat' }));

        // Assert
        expect(result).toEqual({ code: 'PATHSPEC_NO_MATCH', pattern: 'feat', patterns: ['feat'] });
      });
    });

    describe('When checkout switches to the name with the guess turned on', () => {
      it('Then the branch is guessed and HEAD attaches to it', async () => {
        // Arrange
        const { ctx, second } = await seed('[checkout]\n\tguess = false\n');
        const sut = checkout;

        // Act
        const result = await sut(ctx, { rev: 'feat', guess: true });

        // Assert
        expect(result).toMatchObject({ branch: FEAT, id: second, detached: false });
        expect(await headFile(ctx)).toBe('ref: refs/heads/feat\n');
        expect(await branchSection(ctx, 'feat')).toBe(FEAT_SECTION);
        expect(await lastReflogMessage(ctx, FEAT)).toBe(
          'branch: Created from refs/remotes/origin/feat',
        );
      });
    });
  });

  describe('Given a checkout.guess that is not a boolean', () => {
    describe('When checkout switches to a name with the guess turned off', () => {
      it('Then it refuses the bad config value and HEAD stays', async () => {
        // Arrange
        const { ctx } = await seed('[checkout]\n\tguess = bogus\n');
        const sut = checkout;

        // Act
        const result = await refusalOf(() => sut(ctx, { rev: 'feat', guess: false }));

        // Assert
        expect(result).toMatchObject({
          code: 'CONFIG_BAD_BOOLEAN_VALUE',
          key: 'checkout.guess',
          value: 'bogus',
        });
        expect(await headFile(ctx)).toBe('ref: refs/heads/main\n');
      });
    });
  });

  describe('Given an unborn HEAD and a fetched origin', () => {
    describe('When checkout switches to @', () => {
      it('Then no branch is guessed and @ is an unmatched pathspec', async () => {
        // Arrange
        const { ctx } = await seed();
        await unborn(ctx);
        const sut = checkout;

        // Act
        const result = await refusalOf(() => sut(ctx, { rev: '@' }));

        // Assert
        expect(result).toEqual({ code: 'PATHSPEC_NO_MATCH', pattern: '@', patterns: ['@'] });
      });
    });
  });

  describe('Given a valueless checkout.defaultRemote that refuses when read', () => {
    describe('When checkout detaches at a remote-tracking spelling', () => {
      it('Then it detaches without reading it', async () => {
        // Arrange
        const { ctx, second } = await seed('[checkout]\n\tdefaultRemote\n');
        const sut = checkout;

        // Act
        const result = await sut(ctx, { rev: 'origin/feat' });

        // Assert
        expect(result).toMatchObject({ branch: undefined, id: second, detached: true });
      });
    });

    describe('When checkout switches to an existing branch', () => {
      it('Then it switches without reading it', async () => {
        // Arrange
        const { ctx } = await seed('[checkout]\n\tdefaultRemote\n');
        await branchCreate(ctx, { name: 'side' });
        const sut = checkout;

        // Act
        const result = await sut(ctx, { rev: 'side' });

        // Assert
        expect(result).toMatchObject({ branch: 'refs/heads/side', detached: false });
      });
    });

    describe('When checkout creates a branch from a name only a remote-tracking ref carries', () => {
      it('Then no guess is made and the start point is refused', async () => {
        // Arrange
        const { ctx } = await seed('[checkout]\n\tdefaultRemote\n');
        const sut = checkout;

        // Act
        const result = await refusalOf(() =>
          sut(ctx, { rev: 'feat', createBranch: { name: 'x' } }),
        );

        // Assert
        expect(result).toEqual({
          code: 'CHECKOUT_START_POINT_NOT_COMMIT',
          revision: 'feat',
          branch: 'x',
        });
      });
    });
  });
});
