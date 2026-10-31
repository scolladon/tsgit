/**
 * A loose ref that is a symbolic link. git's ref-store check reports it as a
 * `symlinkRef` warning on every link under `refs/` — whatever its text names
 * and whether or not it resolves — and still exits 0.
 */
import { mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { createNodeContext } from '../../../../src/adapters/node/node-adapter.js';
import { fsck } from '../../../../src/application/commands/fsck.js';
import { init } from '../../../../src/application/commands/init.js';
import { createRefStore } from '../../../../src/application/primitives/ref-store.js';
import { updateRef } from '../../../../src/application/primitives/update-ref.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import type { AuthorIdentity, ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import { emptyTreeOid } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const SIDE = 'refs/heads/side' as RefName;
const EXIT_CLEAN = 0;
const EXIT_REFS_CONTENT = 8;
const DYING = 'refs/heads/dying' as RefName;

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const memoryRepo = async (): Promise<Context> => {
  const ctx = await createMemoryContext();
  await init(ctx);
  return ctx;
};

const nodeRepo = async (): Promise<Context> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-symlinked-ref-'));
  tempRoots.push(root);
  const ctx = createNodeContext({ workDir: root });
  await init(ctx);
  return ctx;
};

const ADAPTERS = [
  { adapter: 'memory', build: memoryRepo },
  { adapter: 'node', build: nodeRepo },
] as const;

const gitPath = (ctx: Context, relative: string): string => `${ctx.layout.gitDir}/${relative}`;

/** A repository whose `side` names one commit. */
const seedRepository = async (build: () => Promise<Context>): Promise<Context> => {
  const ctx = await build();
  await writeObject(ctx, { type: 'tree', id: '' as ObjectId, entries: [] });
  const id = await writeObject(ctx, {
    type: 'commit',
    id: '' as ObjectId,
    data: {
      tree: emptyTreeOid(ctx.hashConfig),
      parents: [],
      author: AUTHOR,
      committer: AUTHOR,
      message: 'c1',
      extraHeaders: [],
    },
  });
  await updateRef(ctx, SIDE, id, { reflogMessage: 'plant' });
  return ctx;
};

describe('fsck — a loose ref that is a symbolic link', () => {
  describe.each(ADAPTERS)('$adapter adapter', ({ build }) => {
    describe('Given a link whose text names a ref', () => {
      describe('When the store reports its integrity', () => {
        it('Then the link is reported as a symlinked ref', async () => {
          // Arrange
          const ctx = await seedRepository(build);
          await ctx.fs.symlink(SIDE, gitPath(ctx, 'refs/heads/sym'));
          const sut = createRefStore(ctx);

          // Act
          const findings = await sut.verifyIntegrity();

          // Assert
          expect(findings).toContainEqual({ ref: 'refs/heads/sym', msgId: 'symlinkRef' });
        });
      });
    });

    describe('Given a link whose text is read through to a file', () => {
      describe('When the store reports its integrity', () => {
        it('Then the link is reported as a symlinked ref', async () => {
          // Arrange
          const ctx = await seedRepository(build);
          await ctx.fs.symlink('side', gitPath(ctx, 'refs/heads/rel'));
          const sut = createRefStore(ctx);

          // Act
          const findings = await sut.verifyIntegrity();

          // Assert
          expect(findings).toContainEqual({ ref: 'refs/heads/rel', msgId: 'symlinkRef' });
        });
      });
    });

    describe('Given a link that resolves to a directory of refs', () => {
      describe('When the store reports its integrity', () => {
        it('Then the link itself is reported and nothing under it is', async () => {
          // Arrange
          const ctx = await seedRepository(build);
          await ctx.fs.writeUtf8(gitPath(ctx, 'refs/other/m'), `${'0'.repeat(40)}\n`);
          await ctx.fs.symlink('../other', gitPath(ctx, 'refs/heads/dl'));
          const sut = createRefStore(ctx);

          // Act
          const findings = await sut.verifyIntegrity();

          // Assert
          expect(
            findings.filter((finding) => 'msgId' in finding && finding.msgId === 'symlinkRef'),
          ).toEqual([{ ref: 'refs/heads/dl', msgId: 'symlinkRef' }]);
        });
      });
    });

    describe('Given a link that resolves nowhere', () => {
      describe('When the store reports its integrity', () => {
        it('Then it is still reported as a symlinked ref', async () => {
          // Arrange
          const ctx = await seedRepository(build);
          await ctx.fs.symlink('nowhere', gitPath(ctx, 'refs/heads/dang'));
          const sut = createRefStore(ctx);

          // Act
          const findings = await sut.verifyIntegrity();

          // Assert
          expect(findings).toContainEqual({ ref: 'refs/heads/dang', msgId: 'symlinkRef' });
        });
      });
    });

    describe('Given no loose ref is a symbolic link', () => {
      describe('When the store reports its integrity', () => {
        it('Then no symlinked-ref finding is produced', async () => {
          // Arrange
          const ctx = await seedRepository(build);
          const sut = createRefStore(ctx);

          // Act
          const findings = await sut.verifyIntegrity();

          // Assert
          expect(
            findings.some((finding) => 'msgId' in finding && finding.msgId === 'symlinkRef'),
          ).toBe(false);
        });
      });
    });

    describe('Given a symlinked ref in an otherwise healthy repository', () => {
      describe('When fsck audits it', () => {
        it('Then the audit warns about the link and still exits clean', async () => {
          // Arrange
          const ctx = await seedRepository(build);
          await ctx.fs.symlink('side', gitPath(ctx, 'refs/heads/sym'));
          const sut = fsck;

          // Act
          const result = await sut(ctx);

          // Assert
          expect(result.findings).toContainEqual({
            type: 'bad-ref',
            ref: 'refs/heads/sym',
            msgId: 'symlinkRef',
            severity: 'warning',
          });
          expect(result.exitCode).toBe(EXIT_CLEAN);
        });
      });
    });

    describe('Given a link whose realpath dies in an absent directory', () => {
      describe('When fsck audits it', () => {
        it('Then the end of the refs walk is reported and the exit carries the refs bit', async () => {
          // Arrange
          const ctx = await seedRepository(build);
          await ctx.fs.symlink('absent-dir/x', gitPath(ctx, 'refs/heads/dying'));
          const sut = fsck;

          // Act
          const result = await sut(ctx);

          // Assert
          expect(result.findings).toContainEqual({
            type: 'refs-verify-ended',
            ref: DYING,
            path: expect.stringMatching(/\/\.git\/refs\/heads\/absent-dir$/),
            reason: 'FILE_NOT_FOUND',
          });
          expect(result.exitCode).toBe(EXIT_REFS_CONTENT);
        });
      });

      describe('When fsck audits it without checking references', () => {
        it('Then neither the end of the walk nor its exit bit is reported', async () => {
          // Arrange
          const ctx = await seedRepository(build);
          await ctx.fs.symlink('absent-dir/x', gitPath(ctx, 'refs/heads/dying'));
          const sut = fsck;

          // Act
          const result = await sut(ctx, { checkReferences: false });

          // Assert
          expect(result.findings.map((finding) => finding.type)).not.toContain('refs-verify-ended');
          expect(result.exitCode).toBe(EXIT_CLEAN);
        });
      });

      describe('When fsck audits it beside a ref naming an absent object', () => {
        it('Then the pointer finding of that ref still stands', async () => {
          // Arrange
          const ctx = await seedRepository(build);
          await ctx.fs.symlink('absent-dir/x', gitPath(ctx, 'refs/heads/dying'));
          await ctx.fs.writeUtf8(gitPath(ctx, 'refs/heads/ghost'), `${'1'.repeat(40)}\n`);
          const sut = fsck;

          // Act
          const result = await sut(ctx);

          // Assert
          expect(result.findings).toContainEqual({
            type: 'bad-ref',
            ref: 'refs/heads/ghost',
            msgId: 'badRefOid',
            severity: 'error',
            target: '1'.repeat(40),
          });
        });
      });
    });
  });
});

describe('fsck — two loose ref links whose referents git rejects', () => {
  describe.each(ADAPTERS)('$adapter adapter', ({ build }) => {
    describe('Given links a and b to files outside the refs namespace', () => {
      describe('When fsck audits them', () => {
        it('Then each link reports its notice and its verdict together, link by link', async () => {
          // Arrange
          const ctx = await seedRepository(build);
          await ctx.fs.writeUtf8(gitPath(ctx, 'outside'), 'x\n');
          await ctx.fs.symlink('../../outside', gitPath(ctx, 'refs/heads/a'));
          await ctx.fs.symlink('../../outside', gitPath(ctx, 'refs/heads/b'));
          const sut = fsck;

          // Act
          const result = await sut(ctx);

          // Assert
          const reported = result.findings.flatMap((finding) =>
            finding.type === 'bad-ref' && finding.msgId !== 'badRefOid'
              ? [`${finding.ref} ${finding.msgId}`]
              : [],
          );
          expect(reported).toEqual([
            'refs/heads/a symlinkRef',
            'refs/heads/a badReferentName',
            'refs/heads/b symlinkRef',
            'refs/heads/b badReferentName',
          ]);
        });
      });
    });
  });
});

describe('fsck — a loose ref link beside a .git that is itself a link', () => {
  const linkedStore = async (): Promise<{ workDir: string; store: string }> => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tsgit-fsck-gitdir-link-'));
    tempRoots.push(root);
    const workDir = path.join(root, 'work');
    const store = path.join(workDir, 'store.git');
    await init(createNodeContext({ workDir }));
    await rename(path.join(workDir, '.git'), store);
    await symlink(store, path.join(workDir, '.git'));
    await writeFile(`${store}/refs/heads/main`, `${'1'.repeat(40)}\n`);
    await symlink('main', `${store}/refs/heads/ln`);
    return { workDir, store: await realpath(store) };
  };

  describe('Given a store linked as .git and a ref link to a sibling', () => {
    describe('When the store reports its integrity through the .git link', () => {
      it('Then the referent stays absolute and is a badReferentName', async () => {
        // Arrange
        const { workDir, store } = await linkedStore();
        const sut = createRefStore(createNodeContext({ workDir }));

        // Act
        const result = await sut.verifyIntegrity();

        // Assert
        expect(result).toContainEqual({
          ref: 'refs/heads/ln',
          msgId: 'badReferentName',
          referent: path.join(store, 'refs/heads/main'),
        });
      });
    });

    describe('When the store is named by its real path beside that .git link', () => {
      it('Then the referent is relative to the store, as git strips the gitdir it was given', async () => {
        // Arrange
        const { workDir, store } = await linkedStore();
        const sut = createRefStore(createNodeContext({ workDir, gitDir: store }));

        // Act
        const result = await sut.verifyIntegrity();

        // Assert
        expect(result).not.toContainEqual(expect.objectContaining({ msgId: 'badReferentName' }));
      });
    });

    describe('When the layout carries the spelling the gitdir was reached through', () => {
      it('Then that spelling is what is stripped, not the real path', async () => {
        // Arrange
        const { workDir, store } = await linkedStore();
        const spelled = `${workDir}/via-link`;
        await symlink(store, spelled);
        const ctx = createNodeContext({ workDir, gitDir: store });
        const sut = createRefStore({ ...ctx, layout: { ...ctx.layout, gitDirSpelling: spelled } });

        // Act
        const result = await sut.verifyIntegrity();

        // Assert
        expect(result).toContainEqual({
          ref: 'refs/heads/ln',
          msgId: 'badReferentName',
          referent: path.join(store, 'refs/heads/main'),
        });
      });
    });
  });
});
