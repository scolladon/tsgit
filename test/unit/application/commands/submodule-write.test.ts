import { describe, expect, it } from 'vitest';

import { submoduleInit } from '../../../../src/application/commands/submodule.js';
import { __resetConfigCacheForTests } from '../../../../src/application/primitives/config-read.js';
import { TsgitError } from '../../../../src/domain/error.js';
import { buildSeededContext } from '../primitives/fixtures.js';

interface SeedParts {
  readonly gitmodules?: string;
  readonly config?: string;
  readonly head?: string;
}

const seed = async (parts: SeedParts = {}) => {
  __resetConfigCacheForTests();
  const ctx = await buildSeededContext();
  const { workDir, gitDir } = ctx.layout;
  await ctx.fs.writeUtf8(`${gitDir}/HEAD`, parts.head ?? 'ref: refs/heads/main\n');
  if (parts.gitmodules !== undefined) {
    await ctx.fs.writeUtf8(`${workDir}/.gitmodules`, parts.gitmodules);
  }
  if (parts.config !== undefined) {
    await ctx.fs.writeUtf8(`${gitDir}/config`, parts.config);
  }
  return ctx;
};

const readConfigText = async (ctx: Awaited<ReturnType<typeof seed>>): Promise<string> => {
  try {
    return await ctx.fs.readUtf8(`${ctx.layout.gitDir}/config`);
  } catch {
    return '';
  }
};

const GITMODULES_ONE = '[submodule "libs/a"]\n\tpath = libs/a\n\turl = ../a\n';
const ORIGIN = '[remote "origin"]\n\turl = https://h.x/g/super.git\n';

describe('commands/submodule — init', () => {
  describe('Given an un-registered submodule with a relative url', () => {
    describe('When init runs', () => {
      it('Then it writes active + resolved url in git key order', async () => {
        // Arrange
        const ctx = await seed({ gitmodules: GITMODULES_ONE, config: ORIGIN });

        // Act
        const sut = await submoduleInit(ctx);

        // Assert
        expect(sut.entries).toEqual([
          { name: 'libs/a', path: 'libs/a', url: 'https://h.x/g/a', registered: true },
        ]);
        const text = await readConfigText(ctx);
        expect(text).toContain('[submodule "libs/a"]\n\tactive = true\n\turl = https://h.x/g/a\n');
      });
    });
  });

  describe('Given a submodule with a valid update mode', () => {
    describe('When init runs', () => {
      it('Then update is copied after url', async () => {
        // Arrange
        const ctx = await seed({
          gitmodules: `${GITMODULES_ONE}\tupdate = rebase\n`,
          config: ORIGIN,
        });

        // Act
        const sut = await submoduleInit(ctx);

        // Assert
        expect(sut.entries[0]).toMatchObject({ registered: true, update: 'rebase' });
        const text = await readConfigText(ctx);
        expect(text).toContain('\turl = https://h.x/g/a\n\tupdate = rebase\n');
      });
    });
  });

  describe('Given a submodule with a command-form update mode', () => {
    describe('When init runs', () => {
      it('Then it refuses and writes nothing', async () => {
        // Arrange
        const ctx = await seed({
          gitmodules: `${GITMODULES_ONE}\tupdate = !evil\n`,
          config: ORIGIN,
        });

        // Act & Assert
        try {
          await submoduleInit(ctx);
          expect.fail('init did not reject the invalid update mode');
        } catch (err) {
          expect(err).toBeInstanceOf(TsgitError);
          expect((err as TsgitError).data).toMatchObject({
            code: 'INVALID_OPTION',
            option: 'submodule.libs/a.update',
          });
        }
        expect(await readConfigText(ctx)).not.toContain('[submodule "libs/a"]');
      });
    });
  });

  describe('Given a submodule whose url is already registered', () => {
    describe('When init runs', () => {
      it('Then the existing url is preserved and registered is false', async () => {
        // Arrange
        const ctx = await seed({
          gitmodules: GITMODULES_ONE,
          config: `${ORIGIN}[submodule "libs/a"]\n\turl = custom://keep\n`,
        });

        // Act
        const sut = await submoduleInit(ctx);

        // Assert
        expect(sut.entries[0]).toMatchObject({ registered: false, url: 'custom://keep' });
        expect(await readConfigText(ctx)).toContain('\turl = custom://keep\n');
      });
    });
  });

  describe('Given no configured remote and a relative url', () => {
    describe('When init runs', () => {
      it('Then the url resolves against the superproject worktree path', async () => {
        // Arrange
        const ctx = await seed({ gitmodules: GITMODULES_ONE });

        // Act
        const sut = await submoduleInit(ctx);

        // Assert — DEFAULT_WORK_DIR is /repo; ../a off /repo is /a
        expect(sut.entries[0]?.url).toBe('/a');
      });
    });
  });

  describe('Given a paths filter', () => {
    describe('When init runs with a matching path', () => {
      it('Then only that submodule is registered', async () => {
        // Arrange
        const ctx = await seed({
          gitmodules: `${GITMODULES_ONE}[submodule "libs/b"]\n\tpath = libs/b\n\turl = ../b\n`,
          config: ORIGIN,
        });

        // Act
        const sut = await submoduleInit(ctx, { paths: ['libs/b'] });

        // Assert
        expect(sut.entries.map((e) => e.path)).toEqual(['libs/b']);
      });
    });

    describe('When init runs with an unmatched path', () => {
      it('Then it refuses with PATHSPEC_NO_MATCH', async () => {
        // Arrange
        const ctx = await seed({ gitmodules: GITMODULES_ONE, config: ORIGIN });

        // Act & Assert
        try {
          await submoduleInit(ctx, { paths: ['nope'] });
          expect.fail('init did not reject the unmatched path');
        } catch (err) {
          expect(err).toBeInstanceOf(TsgitError);
          expect((err as TsgitError).data.code).toBe('PATHSPEC_NO_MATCH');
        }
      });
    });
  });

  describe('Given an unsafe-named submodule section', () => {
    describe('When init runs', () => {
      it('Then the unsafe row is dropped', async () => {
        // Arrange
        const ctx = await seed({
          gitmodules: `[submodule "../evil"]\n\tpath = e\n\turl = ../x\n${GITMODULES_ONE}`,
          config: ORIGIN,
        });

        // Act
        const sut = await submoduleInit(ctx);

        // Assert
        expect(sut.entries.map((e) => e.name)).toEqual(['libs/a']);
      });
    });
  });

  describe('Given a submodule section without a path', () => {
    describe('When init runs', () => {
      it('Then the path-less row is skipped', async () => {
        // Arrange
        const ctx = await seed({
          gitmodules: `[submodule "nopath"]\n\turl = ../x\n${GITMODULES_ONE}`,
          config: ORIGIN,
        });

        // Act
        const sut = await submoduleInit(ctx);

        // Assert
        expect(sut.entries.map((e) => e.name)).toEqual(['libs/a']);
      });
    });
  });

  describe('Given a submodule section without a url', () => {
    describe('When init runs', () => {
      it('Then the url-less row is skipped', async () => {
        // Arrange
        const ctx = await seed({
          gitmodules: `[submodule "nourl"]\n\tpath = nourl\n${GITMODULES_ONE}`,
          config: ORIGIN,
        });

        // Act
        const sut = await submoduleInit(ctx);

        // Assert
        expect(sut.entries.map((e) => e.name)).toEqual(['libs/a']);
      });
    });
  });

  describe('Given the current branch has a non-origin upstream remote', () => {
    describe('When init runs', () => {
      it('Then the relative url resolves against that remote', async () => {
        // Arrange
        const ctx = await seed({
          gitmodules: GITMODULES_ONE,
          config:
            '[remote "upstream"]\n\turl = https://up/g/super.git\n[branch "main"]\n\tremote = upstream\n',
        });

        // Act
        const sut = await submoduleInit(ctx);

        // Assert
        expect(sut.entries[0]?.url).toBe('https://up/g/a');
      });
    });
  });

  describe('Given a detached HEAD', () => {
    describe('When init runs', () => {
      it('Then the base remote falls back to origin', async () => {
        // Arrange
        const ctx = await seed({
          gitmodules: GITMODULES_ONE,
          config: ORIGIN,
          head: `${'a'.repeat(40)}\n`,
        });

        // Act
        const sut = await submoduleInit(ctx);

        // Assert
        expect(sut.entries[0]?.url).toBe('https://h.x/g/a');
      });
    });
  });

  describe('Given no .gitmodules in the worktree', () => {
    describe('When init runs', () => {
      it('Then it is a no-op', async () => {
        // Arrange
        const ctx = await seed({ config: ORIGIN });

        // Act
        const sut = await submoduleInit(ctx);

        // Assert
        expect(sut.entries).toEqual([]);
      });
    });
  });

  describe('Given a non-repository context', () => {
    describe('When init runs', () => {
      it('Then it throws NOT_A_REPOSITORY', async () => {
        // Arrange
        __resetConfigCacheForTests();
        const ctx = await buildSeededContext();

        // Act & Assert
        try {
          await submoduleInit(ctx);
          expect.fail('init did not reject the non-repository context');
        } catch (err) {
          expect(err).toBeInstanceOf(TsgitError);
          expect((err as TsgitError).data.code).toBe('NOT_A_REPOSITORY');
        }
      });
    });
  });
});
