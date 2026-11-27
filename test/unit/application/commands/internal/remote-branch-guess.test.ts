import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../../src/application/commands/add.js';
import { commit } from '../../../../../src/application/commands/commit.js';
import { init } from '../../../../../src/application/commands/init.js';
import { checkFilename } from '../../../../../src/application/commands/internal/misspelt-revision.js';
import {
  type GuessCandidate,
  parseRemoteBranch,
  readCheckoutGuess,
  uniqueTrackingName,
} from '../../../../../src/application/commands/internal/remote-branch-guess.js';
import { __resetConfigCacheForTests } from '../../../../../src/application/primitives/config-read.js';
import { updateRef } from '../../../../../src/application/primitives/update-ref.js';
import type { TsgitError } from '../../../../../src/domain/error.js';
import type { AuthorIdentity, ObjectId, RefName } from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';

const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const remoteSection = (name: string, ...fetch: ReadonlyArray<string>): string =>
  [`[remote "${name}"]`, '\turl = /up', ...fetch.map((spec) => `\tfetch = ${spec}`), ''].join('\n');

const ORIGIN = remoteSection('origin', '+refs/heads/*:refs/remotes/origin/*');
const OTHER = remoteSection('other', '+refs/heads/*:refs/remotes/other/*');
const DEFAULT_REMOTE_KEY = 'checkout.defaultremote';

interface Seeded {
  readonly ctx: Context;
  readonly id: ObjectId;
  readonly configPath: string;
}

/** One commit on `main`; `refs` are remote-tracking refs planted at it; `config` is appended. */
const seed = async (config: string, refs: ReadonlyArray<string>): Promise<Seeded> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
  await add(ctx, ['a.txt']);
  const { id } = await commit(ctx, { message: 'first', author: AUTHOR });
  for (const ref of refs) {
    await updateRef(ctx, ref as RefName, id, { reflogMessage: 'plant' });
  }
  const configPath = `${ctx.layout.gitDir}/config`;
  const initial = await ctx.fs.readUtf8(configPath);
  await ctx.fs.writeUtf8(configPath, `${initial}${config}`);
  __resetConfigCacheForTests();
  return { ctx, id, configPath };
};

/** The 1-based line of the last config line equal to `text`. */
const lastLineOf = async (ctx: Context, configPath: string, text: string): Promise<number> =>
  (await ctx.fs.readUtf8(configPath)).split('\n').lastIndexOf(text) + 1;

const thrownBy = async (run: () => Promise<unknown>): Promise<TsgitError | undefined> => {
  try {
    await run();
  } catch (error) {
    return error as TsgitError;
  }
  return undefined;
};

const refusalOf = async (run: () => Promise<unknown>): Promise<unknown> =>
  (await thrownBy(run))?.data;

/** The candidate checkout hands the guess: the name, probed as a path the way git probes it. */
const candidateOf = async (ctx: Context, name: string): Promise<GuessCandidate> => ({
  name,
  namesPath: await checkFilename(ctx, name),
});

const ORIGIN_FEAT = 'refs/remotes/origin/feat';
const OTHER_FEAT = 'refs/remotes/other/feat';

describe('uniqueTrackingName', () => {
  describe('Given one remote whose fetch refspec maps the name onto a tracking ref', () => {
    describe('When the name is guessed', () => {
      it('Then that ref is chosen and the remote is the only match', async () => {
        // Arrange
        const { ctx, id } = await seed(ORIGIN, [ORIGIN_FEAT]);
        const sut = uniqueTrackingName;

        // Act
        const result = await sut(ctx, 'feat');

        // Assert
        expect(result).toEqual({ chosen: { ref: ORIGIN_FEAT, id }, remotes: ['origin'] });
      });
    });
  });

  describe('Given a name no remote-tracking ref carries', () => {
    describe('When the name is guessed', () => {
      it('Then nothing is chosen and no remote matches', async () => {
        // Arrange
        const { ctx } = await seed(ORIGIN, [ORIGIN_FEAT]);
        const sut = uniqueTrackingName;

        // Act
        const result = await sut(ctx, 'missing');

        // Assert
        expect(result).toEqual({ chosen: undefined, remotes: [] });
      });
    });
  });

  describe('Given a tracking ref and no remote configured', () => {
    describe('When the name is guessed', () => {
      it('Then no remote matches', async () => {
        // Arrange
        const { ctx } = await seed('', [ORIGIN_FEAT]);
        const sut = uniqueTrackingName;

        // Act
        const result = await sut(ctx, 'feat');

        // Assert
        expect(result).toEqual({ chosen: undefined, remotes: [] });
      });
    });
  });

  describe('Given two remotes carrying the name and no default remote', () => {
    describe('When the name is guessed', () => {
      it('Then nothing is chosen and both remotes match in config order', async () => {
        // Arrange
        const { ctx } = await seed(`${ORIGIN}${OTHER}`, [ORIGIN_FEAT, OTHER_FEAT]);
        const sut = uniqueTrackingName;

        // Act
        const result = await sut(ctx, 'feat');

        // Assert
        expect(result).toEqual({ chosen: undefined, remotes: ['origin', 'other'] });
      });
    });
  });

  describe('Given two remotes carrying the name, the second remote configured first', () => {
    describe('When the name is guessed', () => {
      it('Then the remotes match in config order', async () => {
        // Arrange
        const { ctx } = await seed(`${OTHER}${ORIGIN}`, [ORIGIN_FEAT, OTHER_FEAT]);
        const sut = uniqueTrackingName;

        // Act
        const result = await sut(ctx, 'feat');

        // Assert
        expect(result.remotes).toEqual(['other', 'origin']);
      });
    });
  });

  describe('Given a fetch refspec mapping branches onto another tracking namespace', () => {
    describe('When the name is guessed', () => {
      it('Then the ref in that namespace is chosen', async () => {
        // Arrange
        const mirror = 'refs/remotes/mirror/feat';
        const config = remoteSection('origin', '+refs/heads/*:refs/remotes/mirror/*');
        const { ctx, id } = await seed(config, [mirror]);
        const sut = uniqueTrackingName;

        // Act
        const result = await sut(ctx, 'feat');

        // Assert
        expect(result).toEqual({ chosen: { ref: mirror, id }, remotes: ['origin'] });
      });
    });
  });

  describe('Given a remote whose first refspec and a later exact one both map the name', () => {
    describe('When the name is guessed', () => {
      it('Then the first refspec decides the ref', async () => {
        // Arrange
        const config = remoteSection(
          'origin',
          '+refs/heads/*:refs/remotes/origin/*',
          '+refs/heads/feat:refs/remotes/zz/feat',
        );
        const { ctx, id } = await seed(config, [ORIGIN_FEAT, 'refs/remotes/zz/feat']);
        const sut = uniqueTrackingName;

        // Act
        const result = await sut(ctx, 'feat');

        // Assert
        expect(result.chosen).toEqual({ ref: ORIGIN_FEAT, id });
      });
    });
  });

  describe('Given a refspec mapping the name onto a ref that does not exist', () => {
    describe('When the name is guessed', () => {
      it('Then no remote matches', async () => {
        // Arrange
        const config = remoteSection('origin', '+refs/heads/*:refs/remotes/mirror/*');
        const { ctx } = await seed(config, [ORIGIN_FEAT]);
        const sut = uniqueTrackingName;

        // Act
        const result = await sut(ctx, 'feat');

        // Assert
        expect(result).toEqual({ chosen: undefined, remotes: [] });
      });
    });
  });

  describe('Given a remote without any fetch refspec', () => {
    describe('When the name is guessed', () => {
      it('Then no remote matches', async () => {
        // Arrange
        const { ctx } = await seed(remoteSection('origin'), [ORIGIN_FEAT]);
        const sut = uniqueTrackingName;

        // Act
        const result = await sut(ctx, 'feat');

        // Assert
        expect(result).toEqual({ chosen: undefined, remotes: [] });
      });
    });
  });

  describe('Given a negative refspec naming the branch the guess maps', () => {
    describe('When the name is guessed', () => {
      it('Then the ref is still chosen, as the reversed query keeps it', async () => {
        // Arrange
        const config = remoteSection(
          'origin',
          '+refs/heads/*:refs/remotes/origin/*',
          '^refs/heads/feat',
        );
        const { ctx, id } = await seed(config, [ORIGIN_FEAT]);
        const sut = uniqueTrackingName;

        // Act
        const result = await sut(ctx, 'feat');

        // Assert
        expect(result.chosen).toEqual({ ref: ORIGIN_FEAT, id });
      });
    });
  });

  describe('Given a refspec mapping branches onto local branches that lack the name', () => {
    describe('When the name is guessed', () => {
      it('Then no remote matches', async () => {
        // Arrange
        const config = remoteSection('origin', '+refs/heads/*:refs/heads/*');
        const { ctx } = await seed(config, ['refs/remotes/origin/only-up']);
        const sut = uniqueTrackingName;

        // Act
        const result = await sut(ctx, 'only-up');

        // Assert
        expect(result).toEqual({ chosen: undefined, remotes: [] });
      });
    });
  });

  describe.each(['@{-1}', '*.txt', 'feat..x', 'a:b', 'x^{tree}', 'x.lock', '.x', 'x/'])(
    'Given the name %s no refname can carry',
    (name) => {
      describe('When the name is guessed', () => {
        it('Then no remote matches and nothing refuses', async () => {
          // Arrange
          const { ctx } = await seed(ORIGIN, [ORIGIN_FEAT]);
          const sut = uniqueTrackingName;

          // Act
          const result = await sut(ctx, name);

          // Assert
          expect(result).toEqual({ chosen: undefined, remotes: [] });
        });
      });
    },
  );

  describe('Given two remotes carrying the name and the second as default remote', () => {
    describe('When the name is guessed', () => {
      it("Then the default remote's ref is chosen", async () => {
        // Arrange
        const config = `${ORIGIN}${OTHER}[checkout]\n\tdefaultRemote = other\n`;
        const { ctx, id } = await seed(config, [ORIGIN_FEAT, OTHER_FEAT]);
        const sut = uniqueTrackingName;

        // Act
        const result = await sut(ctx, 'feat');

        // Assert
        expect(result).toEqual({ chosen: { ref: OTHER_FEAT, id }, remotes: ['origin', 'other'] });
      });
    });
  });

  describe.each([
    { label: 'a remote no match comes from', value: 'nope' },
    { label: 'the default remote spelled in another case', value: 'OTHER' },
  ])('Given two remotes carrying the name and $label as default remote', ({ value }) => {
    describe('When the name is guessed', () => {
      it('Then nothing is chosen', async () => {
        // Arrange
        const config = `${ORIGIN}${OTHER}[checkout]\n\tdefaultRemote = ${value}\n`;
        const { ctx } = await seed(config, [ORIGIN_FEAT, OTHER_FEAT]);
        const sut = uniqueTrackingName;

        // Act
        const result = await sut(ctx, 'feat');

        // Assert
        expect(result).toEqual({ chosen: undefined, remotes: ['origin', 'other'] });
      });
    });
  });

  describe('Given one match and a default remote that carries no ref', () => {
    describe('When the name is guessed', () => {
      it('Then the one match is chosen', async () => {
        // Arrange
        const config = `${ORIGIN}${OTHER}[checkout]\n\tdefaultRemote = other\n`;
        const { ctx, id } = await seed(config, [ORIGIN_FEAT]);
        const sut = uniqueTrackingName;

        // Act
        const result = await sut(ctx, 'feat');

        // Assert
        expect(result).toEqual({ chosen: { ref: ORIGIN_FEAT, id }, remotes: ['origin'] });
      });
    });
  });

  describe('Given two default remotes, the last naming the first remote', () => {
    describe('When the name is guessed', () => {
      it('Then the last default decides', async () => {
        // Arrange
        const config = `${ORIGIN}${OTHER}[checkout]\n\tdefaultRemote = other\n\tdefaultRemote = origin\n`;
        const { ctx, id } = await seed(config, [ORIGIN_FEAT, OTHER_FEAT]);
        const sut = uniqueTrackingName;

        // Act
        const result = await sut(ctx, 'feat');

        // Assert
        expect(result.chosen).toEqual({ ref: ORIGIN_FEAT, id });
      });
    });
  });

  describe('Given a valueless default remote followed by one naming the second remote', () => {
    describe('When the name is guessed', () => {
      it('Then the valued entry decides', async () => {
        // Arrange
        const config = `${ORIGIN}${OTHER}[checkout]\n\tdefaultRemote\n\tdefaultRemote = other\n`;
        const { ctx, id } = await seed(config, [ORIGIN_FEAT, OTHER_FEAT]);
        const sut = uniqueTrackingName;

        // Act
        const result = await sut(ctx, 'feat');

        // Assert
        expect(result.chosen).toEqual({ ref: OTHER_FEAT, id });
      });
    });
  });

  describe.each([
    { label: 'two matches', refs: [ORIGIN_FEAT, OTHER_FEAT] },
    { label: 'one match', refs: [ORIGIN_FEAT] },
    { label: 'no match', refs: [] },
  ])('Given a valueless last default remote and $label', ({ refs }) => {
    describe('When the name is guessed', () => {
      it('Then it refuses the missing value at its line', async () => {
        // Arrange
        const config = `${ORIGIN}${OTHER}[checkout]\n\tdefaultRemote\n`;
        const { ctx, configPath } = await seed(config, refs);
        const line = await lastLineOf(ctx, configPath, '\tdefaultRemote');
        const sut = uniqueTrackingName;

        // Act
        const result = await refusalOf(() => sut(ctx, 'feat'));

        // Assert
        expect(result).toEqual({
          code: 'CONFIG_MISSING_VALUE',
          key: DEFAULT_REMOTE_KEY,
          source: configPath,
          line,
        });
      });
    });
  });

  describe.each([
    ...[
      'url',
      'pushurl',
      'push',
      'fetch',
      'receivepack',
      'uploadpack',
      'proxy',
      'proxyauthmethod',
      'vcs',
      'serveroption',
    ].map((key) => ({ entry: `[remote "zed"]\n\t${key}\n`, key: `remote.zed.${key}` })),
    { entry: '[remote]\n\tpushdefault\n', key: 'remote.pushdefault' },
    ...['remote', 'merge', 'pushremote'].map((key) => ({
      entry: `[branch "x"]\n\t${key}\n`,
      key: `branch.x.${key}`,
    })),
    ...['insteadof', 'pushinsteadof'].map((key) => ({
      entry: `[url "y"]\n\t${key}\n`,
      key: `url.y.${key}`,
    })),
  ])('Given a valueless $key in the remote configuration', ({ entry, key }) => {
    describe('When the name is guessed', () => {
      it('Then it refuses the missing value at its line, as reading the remotes does', async () => {
        // Arrange
        const { ctx, configPath } = await seed(`${ORIGIN}${entry}`, [ORIGIN_FEAT]);
        const line = (await ctx.fs.readUtf8(configPath)).split('\n').length - 1;
        const sut = uniqueTrackingName;

        // Act
        const result = await refusalOf(() => sut(ctx, 'feat'));

        // Assert
        expect(result).toEqual({ code: 'CONFIG_MISSING_VALUE', key, source: configPath, line });
      });
    });
  });

  describe('Given two valueless remote keys', () => {
    describe('When the name is guessed', () => {
      it('Then it refuses the one on the lower line', async () => {
        // Arrange
        const rewrite = 'insteadof';
        const config = `${ORIGIN}[url "y"]\n\t${rewrite}\n[remote "zed"]\n\tfetch\n`;
        const { ctx, configPath } = await seed(config, [ORIGIN_FEAT]);
        const line = await lastLineOf(ctx, configPath, `\t${rewrite}`);
        const sut = uniqueTrackingName;

        // Act
        const result = await refusalOf(() => sut(ctx, 'feat'));

        // Assert
        expect(result).toEqual({
          code: 'CONFIG_MISSING_VALUE',
          key: 'url.y.insteadof',
          source: configPath,
          line,
        });
      });
    });
  });

  describe('Given a valueless remote fetch above a valueless default remote', () => {
    describe('When the name is guessed', () => {
      it('Then it refuses the default remote, read before the remotes', async () => {
        // Arrange
        const config = `${ORIGIN}[remote "zed"]\n\tfetch\n[checkout]\n\tdefaultRemote\n`;
        const { ctx } = await seed(config, [ORIGIN_FEAT]);
        const sut = uniqueTrackingName;

        // Act
        const result = await refusalOf(() => sut(ctx, 'feat'));

        // Assert
        expect(result).toMatchObject({ code: 'CONFIG_MISSING_VALUE', key: DEFAULT_REMOTE_KEY });
      });
    });
  });

  describe.each([
    { label: 'a remote url', entry: '[remote]\n\turl\n' },
    { label: 'a branch merge', entry: '[branch]\n\tmerge\n' },
    { label: 'a URL rewrite', entry: `[url]\n\t${'insteadof'}\n` },
  ])('Given a valueless $label outside any subsection', ({ entry }) => {
    describe('When the name is guessed', () => {
      it('Then reading the remotes ignores it and the ref is chosen', async () => {
        // Arrange
        const { ctx, id } = await seed(`${ORIGIN}${entry}`, [ORIGIN_FEAT]);
        const sut = uniqueTrackingName;

        // Act
        const result = await sut(ctx, 'feat');

        // Assert
        expect(result.chosen).toEqual({ ref: ORIGIN_FEAT, id });
      });
    });
  });

  describe.each(['mirror', 'skipdefaultupdate', 'skipfetchall', 'prune', 'prunetags'])(
    'Given a valueless boolean remote.zed.%s',
    (key) => {
      describe('When the name is guessed', () => {
        it('Then the valueless boolean reads as true and the ref is chosen', async () => {
          // Arrange
          const { ctx, id } = await seed(`${ORIGIN}[remote "zed"]\n\t${key}\n`, [ORIGIN_FEAT]);
          const sut = uniqueTrackingName;

          // Act
          const result = await sut(ctx, 'feat');

          // Assert
          expect(result.chosen).toEqual({ ref: ORIGIN_FEAT, id });
        });
      });
    },
  );
});

describe('parseRemoteBranch', () => {
  describe('Given one remote carrying the name', () => {
    describe('When the branch is parsed', () => {
      it('Then the chosen ref is returned', async () => {
        // Arrange
        const { ctx, id } = await seed(ORIGIN, [ORIGIN_FEAT]);
        const sut = parseRemoteBranch;

        // Act
        const result = await sut(ctx, await candidateOf(ctx, 'feat'));

        // Assert
        expect(result).toEqual({ ref: ORIGIN_FEAT, id });
      });
    });
  });

  describe('Given a name no remote carries', () => {
    describe('When the branch is parsed', () => {
      it('Then nothing is returned', async () => {
        // Arrange
        const { ctx } = await seed(ORIGIN, [ORIGIN_FEAT]);
        const sut = parseRemoteBranch;

        // Act
        const result = await sut(ctx, await candidateOf(ctx, 'missing'));

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given two remotes carrying the name and no default remote', () => {
    describe('When the branch is parsed', () => {
      it('Then it refuses the ambiguous name with both remotes in config order', async () => {
        // Arrange
        const { ctx } = await seed(`${ORIGIN}${OTHER}`, [ORIGIN_FEAT, OTHER_FEAT]);
        const sut = parseRemoteBranch;

        // Act
        const result = await thrownBy(async () => sut(ctx, await candidateOf(ctx, 'feat')));

        // Assert
        expect(result?.data).toEqual({
          code: 'CHECKOUT_REMOTE_BRANCH_AMBIGUOUS',
          name: 'feat',
          remotes: ['origin', 'other'],
        });
        expect(result?.message).toBe(
          "CHECKOUT_REMOTE_BRANCH_AMBIGUOUS: 'feat' matched multiple (2) remote tracking branches",
        );
      });
    });
  });

  describe('Given two remotes carrying the name, the second remote configured first', () => {
    describe('When the branch is parsed', () => {
      it('Then it refuses with the remotes in config order', async () => {
        // Arrange
        const { ctx } = await seed(`${OTHER}${ORIGIN}`, [ORIGIN_FEAT, OTHER_FEAT]);
        const sut = parseRemoteBranch;

        // Act
        const result = await refusalOf(async () => sut(ctx, await candidateOf(ctx, 'feat')));

        // Assert
        expect(result).toEqual({
          code: 'CHECKOUT_REMOTE_BRANCH_AMBIGUOUS',
          name: 'feat',
          remotes: ['other', 'origin'],
        });
      });
    });
  });

  describe.each([
    { label: 'a remote no match comes from', value: 'nope' },
    { label: 'the default remote spelled in another case', value: 'OTHER' },
  ])('Given two remotes carrying the name and $label as default remote', ({ value }) => {
    describe('When the branch is parsed', () => {
      it('Then it refuses the ambiguous name', async () => {
        // Arrange
        const config = `${ORIGIN}${OTHER}[checkout]\n\tdefaultRemote = ${value}\n`;
        const { ctx } = await seed(config, [ORIGIN_FEAT, OTHER_FEAT]);
        const sut = parseRemoteBranch;

        // Act
        const result = await refusalOf(async () => sut(ctx, await candidateOf(ctx, 'feat')));

        // Assert
        expect(result).toEqual({
          code: 'CHECKOUT_REMOTE_BRANCH_AMBIGUOUS',
          name: 'feat',
          remotes: ['origin', 'other'],
        });
      });
    });
  });

  describe('Given one remote carrying the name and an untracked file of that name', () => {
    describe('When the branch is parsed', () => {
      it('Then it refuses the name as both a file and a tracking branch', async () => {
        // Arrange
        const { ctx } = await seed(ORIGIN, [ORIGIN_FEAT]);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/feat`, 'feat');
        const sut = parseRemoteBranch;

        // Act
        const result = await thrownBy(async () => sut(ctx, await candidateOf(ctx, 'feat')));

        // Assert
        expect(result?.data).toEqual({ code: 'CHECKOUT_PATH_OR_TRACKING_BRANCH', name: 'feat' });
        expect(result?.message).toBe(
          "CHECKOUT_PATH_OR_TRACKING_BRANCH: 'feat' could be both a local file and a tracking branch.",
        );
      });
    });
  });

  describe('Given one remote carrying the name and a directory of that name', () => {
    describe('When the branch is parsed', () => {
      it('Then it refuses the name as both a file and a tracking branch', async () => {
        // Arrange
        const { ctx } = await seed(ORIGIN, [ORIGIN_FEAT]);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/feat/x`, 'x');
        const sut = parseRemoteBranch;

        // Act
        const result = await refusalOf(async () => sut(ctx, await candidateOf(ctx, 'feat')));

        // Assert
        expect(result).toEqual({ code: 'CHECKOUT_PATH_OR_TRACKING_BRANCH', name: 'feat' });
      });
    });
  });

  describe('Given one remote carrying the name and a file of that name under a subdirectory', () => {
    describe('When the branch is parsed from that subdirectory', () => {
      it('Then it refuses the name as both a file and a tracking branch', async () => {
        // Arrange
        const { ctx } = await seed(ORIGIN, [ORIGIN_FEAT]);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/sub/feat`, 'feat');
        const fromSub: Context = { ...ctx, cwd: `${ctx.layout.workDir}/sub` };
        const sut = parseRemoteBranch;

        // Act
        const result = await refusalOf(async () =>
          sut(fromSub, await candidateOf(fromSub, 'feat')),
        );

        // Assert
        expect(result).toEqual({ code: 'CHECKOUT_PATH_OR_TRACKING_BRANCH', name: 'feat' });
      });
    });

    describe('When the branch is parsed from the top of the work tree', () => {
      it('Then the chosen ref is returned', async () => {
        // Arrange
        const { ctx, id } = await seed(ORIGIN, [ORIGIN_FEAT]);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/sub/feat`, 'feat');
        const sut = parseRemoteBranch;

        // Act
        const result = await sut(ctx, await candidateOf(ctx, 'feat'));

        // Assert
        expect(result).toEqual({ ref: ORIGIN_FEAT, id });
      });
    });
  });

  describe('Given a file of the name and no remote carrying it', () => {
    describe('When the branch is parsed', () => {
      it('Then nothing is returned', async () => {
        // Arrange
        const { ctx } = await seed(ORIGIN, [ORIGIN_FEAT]);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/missing`, 'missing');
        const sut = parseRemoteBranch;

        // Act
        const result = await sut(ctx, await candidateOf(ctx, 'missing'));

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a file of the name and two remotes carrying it', () => {
    describe('When the branch is parsed', () => {
      it('Then it refuses the ambiguous name', async () => {
        // Arrange
        const { ctx } = await seed(`${ORIGIN}${OTHER}`, [ORIGIN_FEAT, OTHER_FEAT]);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/feat`, 'feat');
        const sut = parseRemoteBranch;

        // Act
        const result = await refusalOf(async () => sut(ctx, await candidateOf(ctx, 'feat')));

        // Assert
        expect(result).toEqual({
          code: 'CHECKOUT_REMOTE_BRANCH_AMBIGUOUS',
          name: 'feat',
          remotes: ['origin', 'other'],
        });
      });
    });
  });

  describe('Given a valueless default remote', () => {
    describe.each(['*.txt', 'f?', '[f]', 'f\\x'])('When the wildcard name %s is parsed', (name) => {
      it('Then nothing is returned and the default remote is never read', async () => {
        // Arrange
        const { ctx } = await seed(`${ORIGIN}[checkout]\n\tdefaultRemote\n`, [ORIGIN_FEAT]);
        const sut = parseRemoteBranch;

        // Act
        const result = await sut(ctx, await candidateOf(ctx, name));

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });
});

describe('readCheckoutGuess', () => {
  describe.each([
    { label: 'no checkout.guess', config: '', expected: true },
    { label: 'checkout.guess false', config: '[checkout]\n\tguess = false\n', expected: false },
    { label: 'a valueless checkout.guess', config: '[checkout]\n\tguess\n', expected: true },
    {
      label: 'checkout.guess false then true',
      config: '[checkout]\n\tguess = false\n\tguess = true\n',
      expected: true,
    },
    {
      label: 'a checkout.guess no boolean reads',
      config: '[checkout]\n\tguess = bogus\n',
      expected: true,
    },
  ])('Given $label', ({ config, expected }) => {
    describe('When the guess setting is read', () => {
      it(`Then it reads ${expected}`, async () => {
        // Arrange
        const { ctx } = await seed(config, []);
        const sut = readCheckoutGuess;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});
