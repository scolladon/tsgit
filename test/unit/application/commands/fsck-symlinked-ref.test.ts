/**
 * A loose ref that is a symbolic link. git's ref-store check reports it as a
 * `symlinkRef` warning on every link under `refs/` — whatever its text names
 * and whether or not it resolves — and still exits 0.
 */
import { mkdtemp, rm } from 'node:fs/promises';
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
          await ctx.fs.symlink(SIDE, gitPath(ctx, 'refs/heads/sym'));
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
  });
});
