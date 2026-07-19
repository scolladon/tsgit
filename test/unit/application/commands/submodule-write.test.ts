import { describe, expect, it } from 'vitest';

import {
  submoduleDeinit,
  submoduleInit,
  submoduleSync,
} from '../../../../src/application/commands/submodule.js';
import { __resetConfigCacheForTests } from '../../../../src/application/primitives/config-read.js';
import { MAX_GITMODULES_BYTES } from '../../../../src/application/primitives/types.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import { TsgitError } from '../../../../src/domain/error.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
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
            reason: expect.stringContaining("invalid value '!evil'"),
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

  describe('Given a submodule whose path escapes the worktree', () => {
    describe('When init runs', () => {
      it('Then the unsafe-path row is dropped', async () => {
        // Arrange
        const ctx = await seed({
          gitmodules: `[submodule "evil"]\n\tpath = ../escape\n\turl = ../x\n${GITMODULES_ONE}`,
          config: ORIGIN,
        });

        // Act
        const sut = await submoduleInit(ctx);

        // Assert
        expect(sut.entries.map((e) => e.name)).toEqual(['libs/a']);
      });
    });
  });

  describe('Given a .gitmodules larger than the byte cap', () => {
    describe('When init runs', () => {
      it('Then it refuses with WORKING_TREE_FILE_TOO_LARGE', async () => {
        // Arrange
        const ctx = await seed({
          gitmodules: 'x'.repeat(MAX_GITMODULES_BYTES + 1),
          config: ORIGIN,
        });

        // Act & Assert
        try {
          await submoduleInit(ctx);
          expect.fail('init did not reject an oversized .gitmodules');
        } catch (err) {
          expect(err).toBeInstanceOf(TsgitError);
          expect((err as TsgitError).data.code).toBe('WORKING_TREE_FILE_TOO_LARGE');
        }
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

  describe('Given a .gitmodules exactly at the byte cap', () => {
    describe('When init runs', () => {
      it('Then it parses without refusing (the cap is exclusive)', async () => {
        // Arrange — pad a valid block to exactly MAX_GITMODULES_BYTES bytes
        const pad = '\n'.repeat(MAX_GITMODULES_BYTES - GITMODULES_ONE.length);
        const ctx = await seed({ gitmodules: `${GITMODULES_ONE}${pad}`, config: ORIGIN });

        // Act
        const sut = await submoduleInit(ctx);

        // Assert — the row still registers; `>` did not trip at exactly the cap
        expect(sut.entries.map((e) => e.name)).toEqual(['libs/a']);
      });
    });
  });

  describe('Given an already-registered submodule with a valid update mode', () => {
    describe('When init runs', () => {
      it('Then the preserved entry still carries the update mode', async () => {
        // Arrange — registered url plus a .gitmodules update mode
        const ctx = await seed({
          gitmodules: `${GITMODULES_ONE}\tupdate = merge\n`,
          config: `${ORIGIN}[submodule "libs/a"]\n\turl = custom://keep\n`,
        });

        // Act
        const sut = await submoduleInit(ctx);

        // Assert
        expect(sut.entries[0]).toMatchObject({
          registered: false,
          url: 'custom://keep',
          update: 'merge',
        });
      });
    });
  });

  describe('Given only a url-less submodule row and no config file', () => {
    describe('When init runs', () => {
      it('Then no config file is written (the op batch is empty)', async () => {
        // Arrange — actionable row (safe path) but no url ⇒ nothing to register
        const ctx = await seed({ gitmodules: '[submodule "x"]\n\tpath = x\n' });

        // Act
        const sut = await submoduleInit(ctx);

        // Assert — the guard suppressed the spurious empty-config write
        expect(sut.entries).toEqual([]);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/config`)).toBe(false);
      });
    });
  });
});

const seedModuleConfig = async (
  ctx: Awaited<ReturnType<typeof seed>>,
  name: string,
  remoteUrl: string,
): Promise<void> => {
  const dir = `${ctx.layout.gitDir}/modules/${name}`;
  await ctx.fs.writeUtf8(`${dir}/HEAD`, 'ref: refs/heads/main\n');
  await ctx.fs.writeUtf8(`${dir}/config`, `[remote "origin"]\n\turl = ${remoteUrl}\n`);
};

describe('commands/submodule — sync', () => {
  describe('Given a fresh clone with nothing initialised', () => {
    describe('When sync runs', () => {
      it('Then it is a no-op (no config writes)', async () => {
        // Arrange
        const ctx = await seed({ gitmodules: GITMODULES_ONE, config: ORIGIN });

        // Act
        const sut = await submoduleSync(ctx);

        // Assert
        expect(sut.entries).toEqual([]);
        expect(await readConfigText(ctx)).not.toContain('[submodule "libs/a"]');
      });
    });
  });

  describe('Given an initialised submodule whose .gitmodules url changed', () => {
    describe('When sync runs', () => {
      it('Then the superproject url is overwritten with the resolved url', async () => {
        // Arrange — registered with a stale url; .gitmodules now points at ../moved
        const ctx = await seed({
          gitmodules: '[submodule "libs/a"]\n\tpath = libs/a\n\turl = ../moved\n',
          config: `${ORIGIN}[submodule "libs/a"]\n\tactive = true\n\turl = https://h.x/g/stale\n`,
        });

        // Act
        const sut = await submoduleSync(ctx);

        // Assert
        expect(sut.entries).toEqual([
          { name: 'libs/a', path: 'libs/a', url: 'https://h.x/g/moved', syncedRemote: false },
        ]);
        expect(await readConfigText(ctx)).toContain('\turl = https://h.x/g/moved\n');
      });
    });
  });

  describe('Given an initialised, checked-out submodule', () => {
    describe('When sync runs', () => {
      it("Then the submodule's own remote.origin.url is updated too", async () => {
        // Arrange
        const ctx = await seed({
          gitmodules: GITMODULES_ONE,
          config: `${ORIGIN}[submodule "libs/a"]\n\tactive = true\n\turl = https://h.x/g/stale\n`,
        });
        await seedModuleConfig(ctx, 'libs/a', 'https://h.x/g/stale');

        // Act
        const sut = await submoduleSync(ctx);

        // Assert
        expect(sut.entries[0]?.syncedRemote).toBe(true);
        const moduleConfig = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/modules/libs/a/config`);
        expect(moduleConfig).toContain('\turl = https://h.x/g/a\n');
        // The remote.origin.url was overwritten in place — the stale value is gone.
        expect(moduleConfig).not.toContain('https://h.x/g/stale');
      });
    });
  });

  describe('Given a paths filter that excludes an initialised submodule', () => {
    describe('When sync runs', () => {
      it('Then only the matched submodule is synced', async () => {
        // Arrange
        const ctx = await seed({
          gitmodules: `${GITMODULES_ONE}[submodule "libs/b"]\n\tpath = libs/b\n\turl = ../b\n`,
          config: `${ORIGIN}[submodule "libs/a"]\n\turl = https://h.x/g/stale\n[submodule "libs/b"]\n\turl = https://h.x/g/stale-b\n`,
        });

        // Act
        const sut = await submoduleSync(ctx, { paths: ['libs/a'] });

        // Assert
        expect(sut.entries.map((e) => e.path)).toEqual(['libs/a']);
      });
    });
  });

  describe('Given submodules declared but no config file', () => {
    describe('When sync runs', () => {
      it('Then no config file is written (nothing is initialised)', async () => {
        // Arrange — .gitmodules only, no .git/config
        const ctx = await seed({ gitmodules: GITMODULES_ONE });

        // Act
        const sut = await submoduleSync(ctx);

        // Assert — the guard suppressed the spurious empty-config write
        expect(sut.entries).toEqual([]);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/config`)).toBe(false);
      });
    });
  });
});

const writeWorktreeFile = async (
  ctx: Awaited<ReturnType<typeof seed>>,
  path: string,
  name: string,
): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${path}/${name}`, 'content\n');
};

/** Seed a checked-out submodule gitdir (empty-tree HEAD) so its status can run. */
const seedCheckedOut = async (
  ctx: Awaited<ReturnType<typeof seed>>,
  name: string,
): Promise<void> => {
  const childGitDir = `${ctx.layout.gitDir}/modules/${name}`;
  const childCtx: Context = Object.freeze({
    ...ctx,
    layout: Object.freeze({ ...ctx.layout, gitDir: childGitDir }),
  });
  const emptyTree = await writeTree(childCtx, []);
  const commitId = await writeObject(childCtx, {
    type: 'commit',
    id: '' as ObjectId,
    data: {
      tree: emptyTree,
      parents: [],
      author: { name: 'A', email: 'a@x', timestamp: 1, timezoneOffset: '+0000' },
      committer: { name: 'A', email: 'a@x', timestamp: 1, timezoneOffset: '+0000' },
      message: 's',
      extraHeaders: [],
    },
  });
  await ctx.fs.writeUtf8(`${childGitDir}/HEAD`, `${commitId}\n`);
};

const REGISTERED_ONE = `${ORIGIN}[submodule "libs/a"]\n\tactive = true\n\turl = https://h.x/g/a\n`;

describe('commands/submodule — deinit', () => {
  describe('Given neither paths nor all', () => {
    describe('When deinit runs', () => {
      it('Then it refuses', async () => {
        // Arrange
        const ctx = await seed({ gitmodules: GITMODULES_ONE, config: REGISTERED_ONE });

        // Act & Assert
        try {
          await submoduleDeinit(ctx);
          expect.fail('deinit did not refuse a bare call');
        } catch (err) {
          expect(err).toBeInstanceOf(TsgitError);
          expect((err as TsgitError).data).toMatchObject({
            code: 'INVALID_OPTION',
            option: 'submodule.deinit',
            reason: expect.stringContaining("use 'all: true'"),
          });
        }
      });
    });
  });

  describe('Given all combined with an explicit pathspec', () => {
    describe('When deinit runs', () => {
      it('Then it refuses the incompatible combination', async () => {
        // Arrange
        const ctx = await seed({ gitmodules: GITMODULES_ONE, config: REGISTERED_ONE });

        // Act & Assert
        try {
          await submoduleDeinit(ctx, { all: true, paths: ['libs/a'] });
          expect.fail('deinit did not refuse all combined with a pathspec');
        } catch (err) {
          expect(err).toBeInstanceOf(TsgitError);
          expect((err as TsgitError).data).toMatchObject({
            code: 'INVALID_OPTION',
            option: 'submodule.deinit',
            reason: expect.stringContaining('incompatible'),
          });
        }
        // The refusal fires before any config write — the section survives intact.
        expect(await readConfigText(ctx)).toContain('[submodule "libs/a"]');
      });
    });
  });

  describe('Given an un-checked-out submodule with a populated worktree', () => {
    describe('When deinit runs without force', () => {
      it('Then it clears the worktree and removes the config section', async () => {
        // Arrange
        const ctx = await seed({ gitmodules: GITMODULES_ONE, config: REGISTERED_ONE });
        await writeWorktreeFile(ctx, 'libs/a', 'file.txt');

        // Act
        const sut = await submoduleDeinit(ctx, { paths: ['libs/a'] });

        // Assert
        expect(sut.entries).toEqual([
          { name: 'libs/a', path: 'libs/a', url: '../a', cleared: true },
        ]);
        expect(await readConfigText(ctx)).not.toContain('[submodule "libs/a"]');
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/libs/a`)).toBe(true);
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/libs/a/file.txt`)).toBe(false);
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/.gitmodules`)).toBe(true);
      });
    });
  });

  describe('Given all=true with two registered submodules', () => {
    describe('When deinit runs', () => {
      it('Then every submodule is cleared and unregistered', async () => {
        // Arrange
        const ctx = await seed({
          gitmodules: `${GITMODULES_ONE}[submodule "libs/b"]\n\tpath = libs/b\n\turl = ../b\n`,
          config: `${REGISTERED_ONE}[submodule "libs/b"]\n\turl = https://h.x/g/b\n`,
        });

        // Act
        const sut = await submoduleDeinit(ctx, { all: true });

        // Assert
        expect(sut.entries.map((e) => e.path)).toEqual(['libs/a', 'libs/b']);
        const text = await readConfigText(ctx);
        expect(text).not.toContain('[submodule "libs/a"]');
        expect(text).not.toContain('[submodule "libs/b"]');
      });
    });
  });

  describe('Given a checked-out submodule with an untracked file', () => {
    describe('When deinit runs without force', () => {
      it('Then it refuses with SUBMODULE_HAS_MODIFICATIONS', async () => {
        // Arrange
        const ctx = await seed({ gitmodules: GITMODULES_ONE, config: REGISTERED_ONE });
        await seedCheckedOut(ctx, 'libs/a');
        await writeWorktreeFile(ctx, 'libs/a', 'dirty.txt');

        // Act & Assert
        try {
          await submoduleDeinit(ctx, { paths: ['libs/a'] });
          expect.fail('deinit did not refuse a dirty submodule');
        } catch (err) {
          expect(err).toBeInstanceOf(TsgitError);
          expect((err as TsgitError).data).toMatchObject({
            code: 'SUBMODULE_HAS_MODIFICATIONS',
            path: 'libs/a',
          });
        }
        expect(await readConfigText(ctx)).toContain('[submodule "libs/a"]');
      });
    });

    describe('When deinit runs with force', () => {
      it('Then the dirty worktree is discarded', async () => {
        // Arrange
        const ctx = await seed({ gitmodules: GITMODULES_ONE, config: REGISTERED_ONE });
        await seedCheckedOut(ctx, 'libs/a');
        await writeWorktreeFile(ctx, 'libs/a', 'dirty.txt');

        // Act
        const sut = await submoduleDeinit(ctx, { paths: ['libs/a'], force: true });

        // Assert
        expect(sut.entries[0]?.cleared).toBe(true);
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/libs/a/dirty.txt`)).toBe(false);
      });
    });
  });

  describe('Given a missing worktree directory', () => {
    describe('When deinit runs', () => {
      it('Then cleared is false', async () => {
        // Arrange
        const ctx = await seed({ gitmodules: GITMODULES_ONE, config: REGISTERED_ONE });

        // Act
        const sut = await submoduleDeinit(ctx, { paths: ['libs/a'] });

        // Assert
        expect(sut.entries[0]?.cleared).toBe(false);
      });
    });
  });

  describe('Given a present but empty worktree directory', () => {
    describe('When deinit runs', () => {
      it('Then cleared is false', async () => {
        // Arrange
        const ctx = await seed({ gitmodules: GITMODULES_ONE, config: REGISTERED_ONE });
        await ctx.fs.mkdir(`${ctx.layout.workDir}/libs/a`);

        // Act
        const sut = await submoduleDeinit(ctx, { paths: ['libs/a'] });

        // Assert
        expect(sut.entries[0]?.cleared).toBe(false);
        expect(await readConfigText(ctx)).not.toContain('[submodule "libs/a"]');
      });
    });
  });

  describe('Given a paths filter with an unmatched path', () => {
    describe('When deinit runs', () => {
      it('Then it refuses with PATHSPEC_NO_MATCH', async () => {
        // Arrange
        const ctx = await seed({ gitmodules: GITMODULES_ONE, config: REGISTERED_ONE });

        // Act & Assert
        try {
          await submoduleDeinit(ctx, { paths: ['nope'] });
          expect.fail('deinit did not reject the unmatched path');
        } catch (err) {
          expect(err).toBeInstanceOf(TsgitError);
          expect((err as TsgitError).data.code).toBe('PATHSPEC_NO_MATCH');
        }
      });
    });
  });

  describe('Given two submodules where the second is dirty', () => {
    describe('When deinit all runs without force', () => {
      it('Then the first is fully deinit-ed before the second refuses', async () => {
        // Arrange — libs/a un-checked-out (clears cleanly), libs/b checked out + dirty
        const ctx = await seed({
          gitmodules: `${GITMODULES_ONE}[submodule "libs/b"]\n\tpath = libs/b\n\turl = ../b\n`,
          config: `${REGISTERED_ONE}[submodule "libs/b"]\n\turl = https://h.x/g/b\n`,
        });
        await writeWorktreeFile(ctx, 'libs/a', 'file.txt');
        await seedCheckedOut(ctx, 'libs/b');
        await writeWorktreeFile(ctx, 'libs/b', 'dirty.txt');

        // Act & Assert
        try {
          await submoduleDeinit(ctx, { all: true });
          expect.fail('deinit did not refuse the dirty second submodule');
        } catch (err) {
          expect((err as TsgitError).data.code).toBe('SUBMODULE_HAS_MODIFICATIONS');
        }
        // libs/a was fully deinit-ed (config removed) before libs/b aborted
        const text = await readConfigText(ctx);
        expect(text).not.toContain('[submodule "libs/a"]');
        expect(text).toContain('[submodule "libs/b"]');
      });
    });
  });

  describe('Given all=true with an unsafe-path row alongside a safe row', () => {
    describe('When deinit runs', () => {
      it('Then the unsafe row is filtered out', async () => {
        // Arrange — an escaping path must never be acted on
        const ctx = await seed({
          gitmodules: `[submodule "evil"]\n\tpath = ../escape\n\turl = ../x\n${GITMODULES_ONE}`,
          config: REGISTERED_ONE,
        });

        // Act
        const sut = await submoduleDeinit(ctx, { all: true });

        // Assert — only the safe libs/a is selected
        expect(sut.entries.map((e) => e.name)).toEqual(['libs/a']);
      });
    });
  });

  describe('Given a paths deinit while a second submodule is registered', () => {
    describe('When deinit runs', () => {
      it('Then only the named submodule is unregistered', async () => {
        // Arrange
        const ctx = await seed({
          gitmodules: `${GITMODULES_ONE}[submodule "libs/b"]\n\tpath = libs/b\n\turl = ../b\n`,
          config: `${REGISTERED_ONE}[submodule "libs/b"]\n\turl = https://h.x/g/b\n`,
        });

        // Act
        const sut = await submoduleDeinit(ctx, { paths: ['libs/a'] });

        // Assert — libs/b is left registered
        expect(sut.entries.map((e) => e.path)).toEqual(['libs/a']);
        expect(await readConfigText(ctx)).toContain('[submodule "libs/b"]');
      });
    });
  });

  describe('Given a submodule absent from config and no config file', () => {
    describe('When deinit runs', () => {
      it('Then no config file is written (nothing to unregister)', async () => {
        // Arrange — .gitmodules only, no .git/config
        const ctx = await seed({ gitmodules: GITMODULES_ONE });

        // Act
        const sut = await submoduleDeinit(ctx, { paths: ['libs/a'] });

        // Assert — the has-section guard suppressed the spurious empty-config write
        expect(sut.entries.map((e) => e.name)).toEqual(['libs/a']);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/config`)).toBe(false);
      });
    });
  });

  describe('Given a deinit of a url-less submodule row', () => {
    describe('When deinit runs', () => {
      it('Then the entry url falls back to the empty string', async () => {
        // Arrange — actionable row (safe path) with no url, registered in config
        const ctx = await seed({
          gitmodules: '[submodule "libs/a"]\n\tpath = libs/a\n',
          config: REGISTERED_ONE,
        });

        // Act
        const sut = await submoduleDeinit(ctx, { paths: ['libs/a'] });

        // Assert
        expect(sut.entries[0]?.url).toBe('');
      });
    });
  });
});
