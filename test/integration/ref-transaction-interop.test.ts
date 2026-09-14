/**
 * Cross-tool interop — `updateRef`'s ref-transaction semantics: the null
 * object id and an absent ref as delete forms, packed-refs deletes under
 * git's locks, the coupled `HEAD` reflog entry, symbolic-ref dereferencing,
 * and the rename commands built on all of it. Two shared bases are built
 * once with canonical git — files and reftable — and every row copies one
 * of them into a fresh `peer` (mutated by git) and `ours` (mutated by
 * tsgit), then compares exit status, refusal data, `git show-ref --verify`
 * presence, `git symbolic-ref` output and the exact appended bytes of every
 * `logs/…` file the row names.
 *
 * @proves
 *   surface:        updateRef, fetch, branch.delete, tag.delete, remote.remove
 *   bucket:         cross-tool-interop
 *   unique:         ref updates dereference symbolic refs and delete as git's ref transaction does
 *   interopSurface: updateRef
 */
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { getRefStore } from '../../src/application/primitives/ref-store.js';
import { updateRef } from '../../src/application/primitives/update-ref.js';
import { TsgitError } from '../../src/domain/error.js';
import type { ObjectId, RefName } from '../../src/domain/objects/index.js';
import type { Context } from '../../src/ports/context.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  git,
  runGit,
  runGitEnv,
  tryRunGitWithExit,
} from './interop-helpers.js';

const SETUP_TIMEOUT = 60_000;
const COMMITTER_EPOCH = 1_700_000_000;

const IDENTITY_ENV: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: 'A',
  GIT_AUTHOR_EMAIL: 'a@x',
  GIT_COMMITTER_NAME: 'A',
  GIT_COMMITTER_EMAIL: 'a@x',
};

/** Pinned identity + time env for a git call whose reflog bytes are
 *  compared byte-for-byte against tsgit's own pinned `Date.now()`. */
const pinnedEnv = (epoch: number): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  ...IDENTITY_ENV,
  GIT_AUTHOR_DATE: `${epoch} +0000`,
  GIT_COMMITTER_DATE: `${epoch} +0000`,
});

const withReftableStorage = (ctx: Context): Context => ({
  ...ctx,
  layout: { ...ctx.layout, refStorage: 'reftable' },
});

const nodeCtx = (dir: string): Context => createNodeContext({ workDir: dir });

/** Whether `p` exists on disk. */
const pathExists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
};

describe.skipIf(!GIT_AVAILABLE)(
  'integration — updateRef ref-transaction parity with canonical git',
  () => {
    let filesBase = '';
    let reftableBase = '';
    let filesC1 = '';
    let filesC2 = '';
    const caseRoots: string[] = [];

    beforeAll(async () => {
      filesBase = await mkdtemp(path.join(os.tmpdir(), 'tsgit-ref-transaction-interop-files-'));
      runGit(['init', '-q', '-b', 'main', filesBase]);
      git(filesBase, 'config', 'user.name', 'A');
      git(filesBase, 'config', 'user.email', 'a@x');
      git(filesBase, 'config', 'commit.gpgsign', 'false');
      git(filesBase, 'config', 'tag.gpgsign', 'false');
      disableAutoMaintenance(filesBase);
      await writeFile(path.join(filesBase, 'f.txt'), 'c1\n');
      git(filesBase, 'add', '-A');
      runGit(['-C', filesBase, 'commit', '-q', '-m', 'c1'], { env: pinnedEnv(COMMITTER_EPOCH) });
      filesC1 = git(filesBase, 'rev-parse', 'HEAD').trim();
      await writeFile(path.join(filesBase, 'f.txt'), 'c2\n');
      git(filesBase, 'add', '-A');
      runGit(['-C', filesBase, 'commit', '-q', '-m', 'c2'], {
        env: pinnedEnv(COMMITTER_EPOCH + 1),
      });
      filesC2 = git(filesBase, 'rev-parse', 'HEAD').trim();
      runGit(['-C', filesBase, 'branch', 'b', 'main'], { env: pinnedEnv(COMMITTER_EPOCH + 2) });
      runGit(['-C', filesBase, 'branch', 'x', 'main'], { env: pinnedEnv(COMMITTER_EPOCH + 3) });
      runGit(['-C', filesBase, 'symbolic-ref', 'refs/heads/sym', 'refs/heads/x']);
      runGit(['-C', filesBase, 'branch', 'p1', 'main'], { env: pinnedEnv(COMMITTER_EPOCH + 4) });
      // Packs ONLY p1 — main/b/x/sym must stay loose for the other rows.
      git(filesBase, 'pack-refs', '--include', 'refs/heads/p1');

      reftableBase = await mkdtemp(
        path.join(os.tmpdir(), 'tsgit-ref-transaction-interop-reftable-'),
      );
      runGit(['init', '-q', '-b', 'main', '--ref-format=reftable', reftableBase]);
      git(reftableBase, 'config', 'user.name', 'A');
      git(reftableBase, 'config', 'user.email', 'a@x');
      git(reftableBase, 'config', 'commit.gpgsign', 'false');
      disableAutoMaintenance(reftableBase);
      await writeFile(path.join(reftableBase, 'f.txt'), 'c1\n');
      git(reftableBase, 'add', '-A');
      runGit(['-C', reftableBase, 'commit', '-q', '-m', 'c1'], { env: pinnedEnv(COMMITTER_EPOCH) });
      runGit(['-C', reftableBase, 'branch', 'rb', 'main'], { env: pinnedEnv(COMMITTER_EPOCH + 1) });
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(filesBase, { recursive: true, force: true });
      await rm(reftableBase, { recursive: true, force: true });
      await Promise.all(
        caseRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
      );
    });

    /** Copies `source` into a fresh, tracked tmpdir. */
    const cloneRepo = async (source: string, slug: string): Promise<string> => {
      const root = await mkdtemp(path.join(os.tmpdir(), `tsgit-ref-transaction-interop-${slug}-`));
      caseRoots.push(root);
      const target = path.join(root, 'repo');
      await cp(source, target, { recursive: true });
      return target;
    };

    /** One files-backend `peer` (git) / `ours` (tsgit) pair, both copies of
     *  the shared files base. */
    const filesCasePair = async (
      slug: string,
    ): Promise<{ readonly peer: string; readonly ours: string; readonly ctx: Context }> => {
      const peer = await cloneRepo(filesBase, `${slug}-peer`);
      const ours = await cloneRepo(filesBase, `${slug}-ours`);
      return { peer, ours, ctx: nodeCtx(ours) };
    };

    const reftableCasePair = async (
      slug: string,
    ): Promise<{ readonly peer: string; readonly ours: string; readonly ctx: Context }> => {
      const peer = await cloneRepo(reftableBase, `${slug}-peer`);
      const ours = await cloneRepo(reftableBase, `${slug}-ours`);
      return { peer, ours, ctx: withReftableStorage(nodeCtx(ours)) };
    };

    const ZERO: ObjectId = '0'.repeat(40) as ObjectId;
    const branchRef = (name: string): RefName => `refs/heads/${name}` as RefName;

    const expectTsgitConflict = async (
      fn: () => Promise<unknown>,
    ): Promise<{ readonly expected: unknown; readonly actual: unknown }> => {
      try {
        await fn();
        expect.unreachable('expected updateRef to throw REF_UPDATE_CONFLICT');
      } catch (err) {
        const data = (err as TsgitError).data;
        expect(data.code).toBe('REF_UPDATE_CONFLICT');
        if (data.code === 'REF_UPDATE_CONFLICT') {
          return { expected: data.expected, actual: data.actual };
        }
        throw err;
      }
      throw new Error('unreachable');
    };

    describe('Given an existing loose branch with a reflog', () => {
      describe('When it is deleted through the null object id', () => {
        it('Then git and tsgit both remove the ref and its log', async () => {
          // Arrange
          const { peer, ours, ctx } = await filesCasePair('existing-null-id');

          // Act
          const gitResult = tryRunGitWithExit(['-C', peer, 'update-ref', 'refs/heads/b', ZERO]);
          await updateRef(ctx, branchRef('b'), ZERO, { reflogMessage: 'delete' });

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(await pathExists(path.join(peer, '.git', 'refs', 'heads', 'b'))).toBe(false);
          expect(await pathExists(path.join(ours, '.git', 'refs', 'heads', 'b'))).toBe(false);
          expect(await pathExists(path.join(peer, '.git', 'logs', 'refs', 'heads', 'b'))).toBe(
            false,
          );
          expect(await pathExists(path.join(ours, '.git', 'logs', 'refs', 'heads', 'b'))).toBe(
            false,
          );
        });
      });

      describe('When it is deleted through -d', () => {
        it('Then git and tsgit both remove the ref and its log', async () => {
          // Arrange
          const { peer, ours, ctx } = await filesCasePair('existing-delete-true');

          // Act
          const gitResult = tryRunGitWithExit(['-C', peer, 'update-ref', '-d', 'refs/heads/b']);
          await updateRef(ctx, branchRef('b'), ZERO, { delete: true });

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(await pathExists(path.join(peer, '.git', 'refs', 'heads', 'b'))).toBe(false);
          expect(await pathExists(path.join(ours, '.git', 'refs', 'heads', 'b'))).toBe(false);
        });
      });
    });

    describe('Given an absent ref', () => {
      describe('When it is deleted through the null object id', () => {
        it('Then git and tsgit both succeed without creating anything', async () => {
          // Arrange
          const { peer, ours, ctx } = await filesCasePair('absent-null-id');

          // Act
          const gitResult = tryRunGitWithExit(['-C', peer, 'update-ref', 'refs/heads/gone', ZERO]);
          await updateRef(ctx, branchRef('gone'), ZERO, { reflogMessage: 'delete' });

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(await pathExists(path.join(peer, '.git', 'refs', 'heads', 'gone'))).toBe(false);
          expect(await pathExists(path.join(ours, '.git', 'refs', 'heads', 'gone'))).toBe(false);
        });
      });

      describe('When it is deleted through -d', () => {
        it('Then git and tsgit both succeed without creating anything', async () => {
          // Arrange
          const { peer, ours, ctx } = await filesCasePair('absent-delete-true');

          // Act
          const gitResult = tryRunGitWithExit(['-C', peer, 'update-ref', '-d', 'refs/heads/gone']);
          await updateRef(ctx, branchRef('gone'), ZERO, { delete: true });

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(await pathExists(path.join(ours, '.git', 'refs', 'heads', 'gone'))).toBe(false);
        });
      });

      describe('When it is deleted with expected: "absent"', () => {
        it('Then git and tsgit both succeed', async () => {
          // Arrange
          const { peer, ours, ctx } = await filesCasePair('absent-expected-absent');

          // Act
          const gitResult = tryRunGitWithExit([
            '-C',
            peer,
            'update-ref',
            '-d',
            'refs/heads/gone',
            ZERO,
          ]);
          await updateRef(ctx, branchRef('gone'), ZERO, { delete: true, expected: 'absent' });

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(await pathExists(path.join(ours, '.git', 'refs', 'heads', 'gone'))).toBe(false);
        });
      });
    });

    describe('Given a delete (via the null id, three-argument form) with a matching expected old value', () => {
      describe('When updateRef is called', () => {
        it('Then git and tsgit both succeed and remove the ref', async () => {
          // Arrange — `b` is branched from `main` after both commits, so its
          // value is `filesC2`, not `filesC1`.
          const { peer, ours, ctx } = await filesCasePair('matching-old');

          // Act
          const gitResult = tryRunGitWithExit([
            '-C',
            peer,
            'update-ref',
            'refs/heads/b',
            ZERO,
            filesC2,
          ]);
          await updateRef(ctx, branchRef('b'), ZERO, {
            expected: filesC2 as ObjectId,
            reflogMessage: 'delete',
          });

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(await pathExists(path.join(peer, '.git', 'refs', 'heads', 'b'))).toBe(false);
          expect(await pathExists(path.join(ours, '.git', 'refs', 'heads', 'b'))).toBe(false);
        });
      });
    });

    describe('Given a delete (via the null id, three-argument form) with a mismatching expected old value', () => {
      describe('When updateRef is called', () => {
        it("Then git refuses (exit 128, its write-form refusal) and tsgit's conflict data matches", async () => {
          // Arrange
          const { peer, ours, ctx } = await filesCasePair('mismatching-old');

          // Act
          const gitResult = tryRunGitWithExit([
            '-C',
            peer,
            'update-ref',
            'refs/heads/b',
            ZERO,
            filesC1,
          ]);
          const conflict = await expectTsgitConflict(() =>
            updateRef(ctx, branchRef('b'), ZERO, {
              expected: filesC1 as ObjectId,
              reflogMessage: 'delete',
            }),
          );

          // Assert
          expect(gitResult.exitCode).toBe(128);
          expect(gitResult.stderr).toContain('is at');
          expect(gitResult.stderr).toContain('but expected');
          expect(conflict.expected).toBe(filesC1);
          expect(conflict.actual).toBe(filesC2);
          expect(await pathExists(path.join(peer, '.git', 'refs', 'heads', 'b'))).toBe(true);
          expect(await pathExists(path.join(ours, '.git', 'refs', 'heads', 'b'))).toBe(true);
        });
      });
    });

    describe('Given a delete (via the null id, three-argument form) with an expected old value on an absent ref', () => {
      describe('When updateRef is called', () => {
        it('Then git refuses to resolve (exit 128) and tsgit\'s actual is "absent"', async () => {
          // Arrange
          const { peer, ours, ctx } = await filesCasePair('old-on-absent');

          // Act
          const gitResult = tryRunGitWithExit([
            '-C',
            peer,
            'update-ref',
            'refs/heads/gone',
            ZERO,
            filesC1,
          ]);
          const conflict = await expectTsgitConflict(() =>
            updateRef(ctx, branchRef('gone'), ZERO, {
              expected: filesC1 as ObjectId,
              reflogMessage: 'delete',
            }),
          );

          // Assert
          expect(gitResult.exitCode).toBe(128);
          expect(gitResult.stderr).toContain('unable to resolve reference');
          expect(conflict.actual).toBe('absent');
          expect(await pathExists(path.join(ours, '.git', 'refs', 'heads', 'gone'))).toBe(false);
        });
      });
    });

    describe('Given expected: "absent" (via the null id, three-argument form) on an existing ref', () => {
      describe('When updateRef is called', () => {
        it('Then git and tsgit both refuse and the ref stays', async () => {
          // Arrange
          const { peer, ours, ctx } = await filesCasePair('expected-absent-existing');

          // Act
          const gitResult = tryRunGitWithExit([
            '-C',
            peer,
            'update-ref',
            'refs/heads/b',
            ZERO,
            ZERO,
          ]);
          await expectTsgitConflict(() =>
            updateRef(ctx, branchRef('b'), ZERO, { expected: 'absent', reflogMessage: 'delete' }),
          );

          // Assert
          expect(gitResult.exitCode).toBe(128);
          expect(gitResult.stderr).toContain('reference already exists');
          expect(await pathExists(path.join(peer, '.git', 'refs', 'heads', 'b'))).toBe(true);
          expect(await pathExists(path.join(ours, '.git', 'refs', 'heads', 'b'))).toBe(true);
        });
      });
    });

    describe('Given an existing loose branch on the reftable backend', () => {
      describe('When it is deleted through the null object id', () => {
        it('Then git and tsgit both remove it', async () => {
          // Arrange
          const { peer, ctx } = await reftableCasePair('reftable-existing');

          // Act
          const gitResult = tryRunGitWithExit(['-C', peer, 'update-ref', 'refs/heads/rb', ZERO]);
          await updateRef(ctx, branchRef('rb'), ZERO, { reflogMessage: 'delete' });

          // Assert
          expect(gitResult.exitCode).toBe(0);
          const gitShow = tryRunGitWithExit(['-C', peer, 'show-ref', '--verify', 'refs/heads/rb']);
          expect(gitShow.exitCode).not.toBe(0);
          expect(await getRefStore(ctx).resolveDirect(branchRef('rb'))).toEqual({
            kind: 'missing',
          });
        });
      });
    });

    describe('Given an absent ref on the reftable backend', () => {
      describe('When it is deleted through -d', () => {
        it('Then git and tsgit both succeed without creating anything', async () => {
          // Arrange
          const { peer, ctx } = await reftableCasePair('reftable-absent');

          // Act
          const gitResult = tryRunGitWithExit(['-C', peer, 'update-ref', '-d', 'refs/heads/gone']);
          await updateRef(ctx, branchRef('gone'), ZERO, { delete: true });

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(await getRefStore(ctx).resolveDirect(branchRef('gone'))).toEqual({
            kind: 'missing',
          });
        });
      });
    });

    // --- Residual rows: today's (pre-fix) behaviour, flipped by a later commit ---

    describe('Given a packed-only ref', () => {
      describe('When it is deleted', () => {
        it('Then git removes the packed-refs line, but tsgit still refuses UNSUPPORTED_OPERATION (packed-refs rewrite lands in a later change)', async () => {
          // Arrange
          const { peer, ours, ctx } = await filesCasePair('packed-only-residual');

          // Act
          const gitResult = tryRunGitWithExit(['-C', peer, 'update-ref', '-d', 'refs/heads/p1']);
          let caught: unknown;
          try {
            await updateRef(ctx, branchRef('p1'), ZERO, { delete: true });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(gitResult.exitCode).toBe(0);
          const gitShow = tryRunGitWithExit(['-C', peer, 'show-ref', '--verify', 'refs/heads/p1']);
          expect(gitShow.exitCode).not.toBe(0);
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('UNSUPPORTED_OPERATION');
          expect(await pathExists(path.join(ours, '.git', 'packed-refs'))).toBe(true);
        });
      });
    });

    describe('Given a symbolic ref', () => {
      describe('When it is deleted by its own name', () => {
        it('Then git deletes the target and keeps the symref, but tsgit still deletes the symref file itself (dereferencing lands in a later change)', async () => {
          // Arrange
          const { peer, ours, ctx } = await filesCasePair('symref-residual');

          // Act
          const gitResult = tryRunGitWithExit([
            '-C',
            peer,
            'update-ref',
            '-d',
            '-m',
            'del',
            'refs/heads/sym',
          ]);
          await updateRef(ctx, branchRef('sym'), ZERO, { reflogMessage: 'del' });

          // Assert — git: the TARGET is gone, the symref itself survives.
          expect(gitResult.exitCode).toBe(0);
          const gitSymShow = tryRunGitWithExit(['-C', peer, 'symbolic-ref', 'refs/heads/sym']);
          expect(gitSymShow.exitCode).toBe(0);
          expect(gitSymShow.stdout.trim()).toBe('refs/heads/x');
          const gitXShow = tryRunGitWithExit(['-C', peer, 'show-ref', '--verify', 'refs/heads/x']);
          expect(gitXShow.exitCode).not.toBe(0);

          // tsgit today: the symref FILE is removed, its target untouched.
          expect(await pathExists(path.join(ours, '.git', 'refs', 'heads', 'sym'))).toBe(false);
          const target = await getRefStore(ctx).resolveDirect(branchRef('x'));
          expect(target).toEqual({ kind: 'direct', id: filesC2 });
        });
      });
    });

    describe('Given HEAD symbolically points at the branch being deleted', () => {
      describe('When it is deleted', () => {
        it('Then git logs the delete to logs/HEAD, but tsgit today writes no HEAD entry (lands in a later change)', async () => {
          // Arrange — main is HEAD's target in the shared base.
          const { peer, ours, ctx } = await filesCasePair('head-entry-residual');
          const dateSpy = vi.spyOn(Date, 'now').mockReturnValue((COMMITTER_EPOCH + 10) * 1000);

          // Act
          try {
            runGit(['-C', peer, 'update-ref', '-d', '-m', 'why', 'refs/heads/main'], {
              env: pinnedEnv(COMMITTER_EPOCH + 10),
            });
            await updateRef(ctx, branchRef('main'), ZERO, { reflogMessage: 'why' });
          } finally {
            dateSpy.mockRestore();
          }

          // Assert — git's logs/HEAD gains an entry (`<old> 0{40} why`);
          // tsgit's does not yet — assert the divergence rather than a shared
          // shape.
          const gitHeadLog = await readFile(path.join(peer, '.git', 'logs', 'HEAD'), 'utf8');
          expect(gitHeadLog).toContain('why');
          const oursHeadLog = await readFile(path.join(ours, '.git', 'logs', 'HEAD'), 'utf8');
          expect(oursHeadLog).not.toContain('why');
        });
      });
    });
  },
);
