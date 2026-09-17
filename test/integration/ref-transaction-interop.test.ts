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
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { remoteRename } from '../../src/application/commands/remote.js';
import { getRefStore, type RefUpdate } from '../../src/application/primitives/ref-store.js';
import { updateRef } from '../../src/application/primitives/update-ref.js';
import type { TsgitError } from '../../src/domain/error.js';
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
    let remoteRenameBase = '';
    let remoteRenameUpstream = '';
    let remoteRenameSrc = '';
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
      // lp: packed at C1, then a loose write shadows it with C2.
      runGit(['-C', filesBase, 'branch', 'lp', filesC1]);
      git(filesBase, 'pack-refs', '--include', 'refs/heads/lp');
      runGit(['-C', filesBase, 'update-ref', 'refs/heads/lp', filesC2]);
      // at1: an annotated tag, packed so packed-refs carries its peel line.
      runGit(['-C', filesBase, 'tag', '-a', 'at1', '-m', 'tag at1', filesC2], {
        env: pinnedEnv(COMMITTER_EPOCH + 6),
      });
      git(filesBase, 'pack-refs', '--include', 'refs/tags/at1');

      // A bare upstream and a clone carrying every tracking-ref shape
      // `remote.rename` must move — packed-only unlogged (keep, main),
      // packed-only logged (lp), loose-over-packed logged (pl), and a
      // logged `origin/HEAD` symref.
      remoteRenameUpstream = await mkdtemp(
        path.join(os.tmpdir(), 'tsgit-ref-transaction-rename-up-'),
      );
      runGit(['init', '-q', '--bare', '-b', 'main', remoteRenameUpstream]);
      remoteRenameSrc = await mkdtemp(path.join(os.tmpdir(), 'tsgit-ref-transaction-rename-src-'));
      runGit(['init', '-q', '-b', 'main', remoteRenameSrc]);
      git(remoteRenameSrc, 'config', 'user.name', 'A');
      git(remoteRenameSrc, 'config', 'user.email', 'a@x');
      git(remoteRenameSrc, 'config', 'commit.gpgsign', 'false');
      disableAutoMaintenance(remoteRenameSrc);
      await writeFile(path.join(remoteRenameSrc, 'f.txt'), 'rename-c1\n');
      git(remoteRenameSrc, 'add', '-A');
      runGit(['-C', remoteRenameSrc, 'commit', '-q', '-m', 'c1'], {
        env: pinnedEnv(COMMITTER_EPOCH + 100),
      });
      for (const name of ['keep', 'lp', 'pl'])
        runGit(['-C', remoteRenameSrc, 'branch', name, 'main']);
      runGit(['-C', remoteRenameSrc, 'remote', 'add', 'origin', remoteRenameUpstream]);
      runGit(['-C', remoteRenameSrc, 'push', '-q', 'origin', 'main', 'keep', 'lp', 'pl'], {
        env: pinnedEnv(COMMITTER_EPOCH + 100),
      });
      remoteRenameBase = await mkdtemp(
        path.join(os.tmpdir(), 'tsgit-ref-transaction-rename-base-'),
      );
      runGit(['clone', '-q', remoteRenameUpstream, remoteRenameBase], {
        env: pinnedEnv(COMMITTER_EPOCH + 100),
      });
      git(remoteRenameBase, 'config', 'user.name', 'A');
      git(remoteRenameBase, 'config', 'user.email', 'a@x');
      disableAutoMaintenance(remoteRenameBase);
      await writeFile(path.join(remoteRenameSrc, 'f.txt'), 'rename-c2\n');
      git(remoteRenameSrc, 'add', '-A');
      runGit(['-C', remoteRenameSrc, 'commit', '-q', '-m', 'c2'], {
        env: pinnedEnv(COMMITTER_EPOCH + 101),
      });
      for (const name of ['lp', 'pl']) {
        runGit(['-C', remoteRenameSrc, 'checkout', '-q', name]);
        runGit(['-C', remoteRenameSrc, 'reset', '-q', '--hard', 'main']);
      }
      runGit(['-C', remoteRenameSrc, 'checkout', '-q', 'main']);
      runGit(['-C', remoteRenameSrc, 'push', '-q', 'origin', 'lp', 'pl'], {
        env: pinnedEnv(COMMITTER_EPOCH + 101),
      });
      runGit(['-C', remoteRenameBase, 'fetch', '-q', 'origin'], {
        env: pinnedEnv(COMMITTER_EPOCH + 101),
      });
      // Packs every tracking ref (keep/lp/main/pl) — origin/HEAD is
      // symbolic and never packs.
      git(remoteRenameBase, 'pack-refs', '--include', 'refs/remotes/origin/*');
      await writeFile(path.join(remoteRenameSrc, 'f.txt'), 'rename-c3\n');
      git(remoteRenameSrc, 'add', '-A');
      runGit(['-C', remoteRenameSrc, 'commit', '-q', '-m', 'c3'], {
        env: pinnedEnv(COMMITTER_EPOCH + 102),
      });
      runGit(['-C', remoteRenameSrc, 'checkout', '-q', 'pl']);
      runGit(['-C', remoteRenameSrc, 'reset', '-q', '--hard', 'main']);
      runGit(['-C', remoteRenameSrc, 'checkout', '-q', 'main']);
      runGit(['-C', remoteRenameSrc, 'push', '-q', 'origin', 'pl'], {
        env: pinnedEnv(COMMITTER_EPOCH + 102),
      });
      // pl is now loose-over-packed, logged twice; keep/main stay
      // packed-only unlogged; lp stays packed-only, logged once.
      runGit(['-C', remoteRenameBase, 'fetch', '-q', 'origin'], {
        env: pinnedEnv(COMMITTER_EPOCH + 102),
      });

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
      await rm(remoteRenameBase, { recursive: true, force: true });
      await rm(remoteRenameUpstream, { recursive: true, force: true });
      await rm(remoteRenameSrc, { recursive: true, force: true });
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

    const remoteRenameCasePair = async (
      slug: string,
    ): Promise<{ readonly peer: string; readonly ours: string; readonly ctx: Context }> => {
      const peer = await cloneRepo(remoteRenameBase, `${slug}-peer`);
      const ours = await cloneRepo(remoteRenameBase, `${slug}-ours`);
      return { peer, ours, ctx: nodeCtx(ours) };
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

    describe('Given a packed ref above a ref of its own that still exists', () => {
      describe('When both tools move the ref under it', () => {
        it('Then both write it — git checks a name only when its own read finds nothing', async () => {
          // Arrange — `refs/remotes/k` packed, `refs/remotes/k/z` loose: a
          // shape neither tool can create, only a hand-written `packed-refs`
          // beside a loose file.
          const { peer, ctx } = await filesCasePair('packed-above-existing');
          for (const dir of [peer, path.dirname(ctx.layout.gitDir)]) {
            await mkdir(path.join(dir, '.git', 'refs', 'remotes', 'k'), { recursive: true });
            await writeFile(path.join(dir, '.git', 'refs', 'remotes', 'k', 'z'), `${filesC1}\n`);
            await writeFile(
              path.join(dir, '.git', 'packed-refs'),
              `# pack-refs with: peeled fully-peeled sorted \n${filesC1} refs/remotes/k\n`,
            );
          }
          const sut = getRefStore(ctx);

          // Act
          const gitResult = tryRunGitWithExit([
            '-C',
            peer,
            'update-ref',
            'refs/remotes/k/z',
            filesC2,
          ]);
          await sut.applyRefUpdates([
            { kind: 'set', name: 'refs/remotes/k/z' as RefName, id: filesC2 as ObjectId },
          ]);

          // Assert
          expect(gitResult.exitCode).toBe(0);
          for (const dir of [peer, path.dirname(ctx.layout.gitDir)]) {
            expect(
              await readFile(path.join(dir, '.git', 'refs', 'remotes', 'k', 'z'), 'utf8'),
            ).toBe(`${filesC2}\n`);
          }
        });
      });
    });

    describe('Given a ref file sitting where another name needs a directory', () => {
      describe('When both tools read the name under it', () => {
        it('Then both report it absent, packed value and all, and still refuse the write', async () => {
          // Arrange — `refs/remotes/q` is a loose file and `refs/remotes/q/z`
          // is packed: git's read stops at the file and never reaches
          // `packed-refs`, while its iterators still list the packed entry.
          const { peer, ctx } = await filesCasePair('file-in-ref-path');
          for (const dir of [peer, path.dirname(ctx.layout.gitDir)]) {
            await mkdir(path.join(dir, '.git', 'refs', 'remotes'), { recursive: true });
            await writeFile(path.join(dir, '.git', 'refs', 'remotes', 'q'), `${filesC1}\n`);
            await writeFile(
              path.join(dir, '.git', 'packed-refs'),
              `# pack-refs with: peeled fully-peeled sorted \n${filesC1} refs/remotes/q/z\n`,
            );
          }
          const sut = getRefStore(ctx);

          // Act
          const gitRead = tryRunGitWithExit([
            '-C',
            peer,
            'rev-parse',
            '--verify',
            'refs/remotes/q/z',
          ]);
          const gitWrite = tryRunGitWithExit([
            '-C',
            peer,
            'update-ref',
            'refs/remotes/q/z/w',
            filesC1,
          ]);
          const read = await sut.resolveDirect('refs/remotes/q/z' as RefName);
          let caught: unknown;
          try {
            await sut.applyRefUpdates([
              { kind: 'set', name: 'refs/remotes/q/z/w' as RefName, id: filesC1 as ObjectId },
            ]);
          } catch (err) {
            caught = err;
          }

          // Assert — neither tool resolves the name
          expect(gitRead.exitCode).toBe(128);
          expect(read).toEqual({ kind: 'missing' });

          // Assert — both still list the packed entry
          expect(git(peer, 'for-each-ref', '--format=%(refname)', 'refs/remotes/')).toContain(
            'refs/remotes/q/z',
          );
          expect([...(await sut.listRefNames('refs/remotes/' as RefName))].sort()).toEqual([
            'refs/remotes/q',
            'refs/remotes/q/z',
          ]);

          // Assert — the write side still names the blocking file
          expect(gitWrite.exitCode).toBe(128);
          expect(gitWrite.stderr).toContain(
            "'refs/remotes/q' exists; cannot create 'refs/remotes/q/z/w'",
          );
          expect((caught as TsgitError).data).toEqual({
            code: 'NOT_A_DIRECTORY',
            path: `${ctx.layout.gitDir}/refs/remotes/q`,
          });
        });
      });
    });

    describe("Given a directory holding a file at a branch's log path", () => {
      describe('When git update-ref and applyRefUpdates write that branch', () => {
        it('Then both refuse before the ref is written and leave the tree untouched', async () => {
          // Arrange
          const { peer, ours, ctx } = await filesCasePair('log-dir-blocked');
          const branch = 'refs/heads/blocked';
          for (const dir of [peer, ours]) {
            await mkdir(path.join(dir, '.git', 'logs', branch), { recursive: true });
            await writeFile(path.join(dir, '.git', 'logs', branch, 'f'), 'kept\n');
          }
          const sut = getRefStore(ctx);

          // Act
          const gitResult = tryRunGitWithExit(
            ['-C', peer, 'update-ref', '-m', 'w', branch, filesC1],
            { env: pinnedEnv(COMMITTER_EPOCH) },
          );
          let caught: unknown;
          try {
            await sut.applyRefUpdates([
              {
                kind: 'set',
                name: branch as RefName,
                id: filesC1 as ObjectId,
                reflog: { oldId: ZERO, newId: filesC1 as ObjectId, message: 'w' },
              },
            ]);
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(gitResult.exitCode).toBe(128);
          expect(gitResult.stderr).toContain(
            `there are still logs under '${path.join('.git', 'logs', branch)}'`,
          );
          expect((caught as TsgitError).data).toEqual({
            code: 'DIRECTORY_NOT_EMPTY',
            path: `${ctx.layout.gitDir}/logs/${branch}`,
          });
          for (const dir of [peer, ours]) {
            expect(await pathExists(path.join(dir, '.git', branch))).toBe(false);
            expect(await readFile(path.join(dir, '.git', 'logs', branch, 'f'), 'utf8')).toBe(
              'kept\n',
            );
          }
        });
      });
    });

    describe('Given a directory holding a file at the log path of a ref git never logs', () => {
      describe('When git update-ref and applyRefUpdates write that ref', () => {
        it('Then both write the ref and leave the blocked log directory alone', async () => {
          // Arrange
          const { peer, ours, ctx } = await filesCasePair('log-dir-unlogged');
          const ref = 'refs/misc/unlogged';
          for (const dir of [peer, ours]) {
            await mkdir(path.join(dir, '.git', 'logs', ref), { recursive: true });
            await writeFile(path.join(dir, '.git', 'logs', ref, 'f'), 'kept\n');
          }
          const sut = getRefStore(ctx);

          // Act
          const gitResult = tryRunGitWithExit(['-C', peer, 'update-ref', '-m', 'w', ref, filesC1], {
            env: pinnedEnv(COMMITTER_EPOCH),
          });
          await sut.applyRefUpdates([
            {
              kind: 'set',
              name: ref as RefName,
              id: filesC1 as ObjectId,
              reflog: { oldId: ZERO, newId: filesC1 as ObjectId, message: 'w' },
            },
          ]);

          // Assert
          expect(gitResult.exitCode).toBe(0);
          for (const dir of [peer, ours]) {
            expect(await readFile(path.join(dir, '.git', ref), 'utf8')).toBe(`${filesC1}\n`);
            expect(await readFile(path.join(dir, '.git', 'logs', ref, 'f'), 'utf8')).toBe('kept\n');
          }
        });
      });
    });

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

    describe('Given a packed-only ref', () => {
      describe('When it is deleted', () => {
        it('Then git and tsgit both remove the packed-refs line (new inode)', async () => {
          // Arrange
          const { peer, ours, ctx } = await filesCasePair('packed-only-delete');
          const oursPackedRefsPath = path.join(ours, '.git', 'packed-refs');
          const inodeBefore = (await stat(oursPackedRefsPath)).ino;

          // Act
          const gitResult = tryRunGitWithExit(['-C', peer, 'update-ref', '-d', 'refs/heads/p1']);
          await updateRef(ctx, branchRef('p1'), ZERO, { delete: true });

          // Assert
          expect(gitResult.exitCode).toBe(0);
          const gitShow = tryRunGitWithExit(['-C', peer, 'show-ref', '--verify', 'refs/heads/p1']);
          expect(gitShow.exitCode).not.toBe(0);
          expect(await getRefStore(ctx).resolveDirect(branchRef('p1'))).toEqual({
            kind: 'missing',
          });
          const inodeAfter = (await stat(oursPackedRefsPath)).ino;
          expect(inodeAfter).not.toBe(inodeBefore);
          const peerPacked = await readFile(path.join(peer, '.git', 'packed-refs'), 'utf8');
          const oursPacked = await readFile(oursPackedRefsPath, 'utf8');
          expect(oursPacked).toBe(peerPacked);
        });
      });
    });

    describe('Given a loose-and-packed ref (lp: packed at C1, loose override at C2)', () => {
      describe('When it is deleted', () => {
        it('Then git and tsgit both remove the loose file and the packed-refs line', async () => {
          // Arrange
          const { peer, ours, ctx } = await filesCasePair('loose-and-packed-delete');

          // Act
          const gitResult = tryRunGitWithExit(['-C', peer, 'update-ref', '-d', 'refs/heads/lp']);
          await updateRef(ctx, branchRef('lp'), ZERO, { delete: true });

          // Assert
          expect(gitResult.exitCode).toBe(0);
          const gitVerify = tryRunGitWithExit([
            '-C',
            peer,
            'rev-parse',
            '--verify',
            'refs/heads/lp',
          ]);
          expect(gitVerify.exitCode).not.toBe(0);
          expect(await pathExists(path.join(peer, '.git', 'refs', 'heads', 'lp'))).toBe(false);
          expect(await pathExists(path.join(ours, '.git', 'refs', 'heads', 'lp'))).toBe(false);
          const peerPacked = await readFile(path.join(peer, '.git', 'packed-refs'), 'utf8');
          expect(peerPacked).not.toContain('refs/heads/lp');
          const oursPacked = await readFile(path.join(ours, '.git', 'packed-refs'), 'utf8');
          expect(oursPacked).toBe(peerPacked);
        });
      });
    });

    describe('Given an annotated tag packed with its own peel line', () => {
      describe('When it is deleted', () => {
        it('Then git and tsgit both drop the entry and its ^ line together', async () => {
          // Arrange
          const { peer, ours, ctx } = await filesCasePair('annotated-tag-delete');
          const tagRef = 'refs/tags/at1' as RefName;

          // Act
          const gitResult = tryRunGitWithExit(['-C', peer, 'update-ref', '-d', 'refs/tags/at1']);
          await updateRef(ctx, tagRef, ZERO, { delete: true });

          // Assert
          expect(gitResult.exitCode).toBe(0);
          const peerPacked = await readFile(path.join(peer, '.git', 'packed-refs'), 'utf8');
          expect(peerPacked).not.toContain('refs/tags/at1');
          expect(peerPacked).not.toMatch(/\^/);
          const oursPacked = await readFile(path.join(ours, '.git', 'packed-refs'), 'utf8');
          expect(oursPacked).toBe(peerPacked);
        });
      });
    });

    describe('Given a loose-only ref with packed-refs present', () => {
      describe('When it is deleted', () => {
        it('Then packed-refs is byte- and inode-unchanged on both sides', async () => {
          // Arrange
          const { peer, ours, ctx } = await filesCasePair('loose-only-delete');
          const peerPackedPath = path.join(peer, '.git', 'packed-refs');
          const oursPackedPath = path.join(ours, '.git', 'packed-refs');
          const peerInodeBefore = (await stat(peerPackedPath)).ino;
          const oursInodeBefore = (await stat(oursPackedPath)).ino;

          // Act
          const gitResult = tryRunGitWithExit(['-C', peer, 'update-ref', '-d', 'refs/heads/b']);
          await updateRef(ctx, branchRef('b'), ZERO, { delete: true });

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect((await stat(peerPackedPath)).ino).toBe(peerInodeBefore);
          expect((await stat(oursPackedPath)).ino).toBe(oursInodeBefore);
        });
      });
    });

    describe('Given a held packed-refs.lock', () => {
      describe('When a packed-only, a loose-only and an absent delete are each attempted', () => {
        it('Then git and tsgit both refuse every one, and the loose file stays put', async () => {
          // Arrange
          const { peer, ours, ctx } = await filesCasePair('packed-refs-lock-delete');
          await writeFile(path.join(peer, '.git', 'packed-refs.lock'), '');
          await writeFile(path.join(ours, '.git', 'packed-refs.lock'), '');

          // Act + Assert — packed-only
          const gitPacked = tryRunGitWithExit(['-C', peer, 'update-ref', '-d', 'refs/heads/p1']);
          expect(gitPacked.exitCode).not.toBe(0);
          let caught: unknown;
          try {
            await updateRef(ctx, branchRef('p1'), ZERO, { delete: true });
            expect.unreachable();
          } catch (err) {
            caught = err;
          }
          expect((caught as TsgitError).data.code).toBe('RESOURCE_LOCKED');

          // Act + Assert — loose-only
          const gitLoose = tryRunGitWithExit(['-C', peer, 'update-ref', '-d', 'refs/heads/b']);
          expect(gitLoose.exitCode).not.toBe(0);
          try {
            await updateRef(ctx, branchRef('b'), ZERO, { delete: true });
            expect.unreachable();
          } catch (err) {
            caught = err;
          }
          expect((caught as TsgitError).data.code).toBe('RESOURCE_LOCKED');
          expect(await pathExists(path.join(ours, '.git', 'refs', 'heads', 'b'))).toBe(true);

          // Act + Assert — absent, both forms
          const gitAbsent = tryRunGitWithExit(['-C', peer, 'update-ref', '-d', 'refs/heads/gone']);
          expect(gitAbsent.exitCode).not.toBe(0);
          try {
            await updateRef(ctx, branchRef('gone'), ZERO, { delete: true });
            expect.unreachable();
          } catch (err) {
            caught = err;
          }
          expect((caught as TsgitError).data.code).toBe('RESOURCE_LOCKED');
        });
      });
    });

    describe('Given a held packed-refs.lock', () => {
      describe('When a non-delete write is attempted', () => {
        it('Then it never takes packed-refs.lock and succeeds on both sides', async () => {
          // Arrange
          const { peer, ours, ctx } = await filesCasePair('packed-refs-lock-write');
          await writeFile(path.join(peer, '.git', 'packed-refs.lock'), '');
          await writeFile(path.join(ours, '.git', 'packed-refs.lock'), '');

          // Act
          const gitResult = tryRunGitWithExit([
            '-C',
            peer,
            'update-ref',
            '-m',
            'w',
            'refs/heads/new',
            filesC1,
          ]);
          await updateRef(ctx, branchRef('new'), filesC1 as ObjectId, { reflogMessage: 'w' });

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(await getRefStore(ctx).resolveDirect(branchRef('new'))).toEqual({
            kind: 'direct',
            id: filesC1,
          });
        });
      });
    });

    describe('Given a header-less packed-refs file written into both copies', () => {
      describe('When an entry is deleted', () => {
        it("Then both rewrites gain git's canonical header", async () => {
          // Arrange
          const { peer, ours, ctx } = await filesCasePair('header-less');
          const headerLess = `${filesC1} refs/heads/aaa\n${filesC2} refs/heads/zzz\n`;
          await writeFile(path.join(peer, '.git', 'packed-refs'), headerLess);
          await writeFile(path.join(ours, '.git', 'packed-refs'), headerLess);

          // Act
          const gitResult = tryRunGitWithExit(['-C', peer, 'update-ref', '-d', 'refs/heads/zzz']);
          await updateRef(ctx, branchRef('zzz'), ZERO, { delete: true });

          // Assert
          const peerPacked = await readFile(path.join(peer, '.git', 'packed-refs'), 'utf8');
          expect(gitResult.exitCode).toBe(0);
          expect(peerPacked.split('\n')[0]).toBe('# pack-refs with: peeled fully-peeled sorted ');
          const oursPacked = await readFile(path.join(ours, '.git', 'packed-refs'), 'utf8');
          expect(oursPacked).toBe(peerPacked);
        });
      });
    });

    describe('Given a header-less, unsorted packed-refs file', () => {
      describe('When a middle entry is deleted', () => {
        it('Then both rewrites come back sorted', async () => {
          // Arrange
          const { peer, ours, ctx } = await filesCasePair('unsorted');
          const unsorted = `${filesC1} refs/heads/zz\n${filesC1} refs/heads/mm\n${filesC1} refs/heads/aa\n`;
          await writeFile(path.join(peer, '.git', 'packed-refs'), unsorted);
          await writeFile(path.join(ours, '.git', 'packed-refs'), unsorted);

          // Act
          const gitResult = tryRunGitWithExit(['-C', peer, 'update-ref', '-d', 'refs/heads/mm']);
          await updateRef(ctx, branchRef('mm'), ZERO, { delete: true });

          // Assert
          const peerPacked = await readFile(path.join(peer, '.git', 'packed-refs'), 'utf8');
          expect(gitResult.exitCode).toBe(0);
          const oursPacked = await readFile(path.join(ours, '.git', 'packed-refs'), 'utf8');
          expect(oursPacked).toBe(peerPacked);
          const names = peerPacked
            .split('\n')
            .filter((line) => line.length > 0 && !line.startsWith('#'))
            .map((line) => line.split(' ')[1]);
          expect(names).toEqual(['refs/heads/aa', 'refs/heads/zz']);
        });
      });
    });

    describe('Given a packed line naming a missing object, alongside an unrelated entry', () => {
      describe('When the unrelated entry is deleted', () => {
        it('Then the missing-object line is copied verbatim — never peeled, never read', async () => {
          // Arrange
          const { peer, ours, ctx } = await filesCasePair('missing-object');
          const missing = 'f'.repeat(40);
          const content = `# pack-refs with: peeled fully-peeled sorted \n${missing} refs/heads/ghost\n${filesC1} refs/heads/victim\n`;
          await writeFile(path.join(peer, '.git', 'packed-refs'), content);
          await writeFile(path.join(ours, '.git', 'packed-refs'), content);

          // Act
          const gitResult = tryRunGitWithExit([
            '-C',
            peer,
            'update-ref',
            '-d',
            'refs/heads/victim',
          ]);
          await updateRef(ctx, branchRef('victim'), ZERO, { delete: true });

          // Assert
          const peerPacked = await readFile(path.join(peer, '.git', 'packed-refs'), 'utf8');
          expect(gitResult.exitCode).toBe(0);
          expect(peerPacked).toContain(`${missing} refs/heads/ghost`);
          const oursPacked = await readFile(path.join(ours, '.git', 'packed-refs'), 'utf8');
          expect(oursPacked).toBe(peerPacked);
        });
      });
    });

    describe('Given the last packed ref', () => {
      describe('When it is deleted', () => {
        it('Then both sides keep packed-refs as the 46-byte header alone', async () => {
          // Arrange — the shared base packs three refs (p1, lp, at1); drop
          // the other two first so p1's own delete is genuinely the LAST one.
          const { peer, ours, ctx } = await filesCasePair('last-packed-ref');
          runGit(['-C', peer, 'update-ref', '-d', 'refs/heads/lp']);
          runGit(['-C', peer, 'update-ref', '-d', 'refs/tags/at1']);
          await updateRef(ctx, branchRef('lp'), ZERO, { delete: true });
          await updateRef(ctx, 'refs/tags/at1' as RefName, ZERO, { delete: true });

          // Act
          const gitResult = tryRunGitWithExit(['-C', peer, 'update-ref', '-d', 'refs/heads/p1']);
          await updateRef(ctx, branchRef('p1'), ZERO, { delete: true });

          // Assert
          expect(gitResult.exitCode).toBe(0);
          const peerPacked = await readFile(path.join(peer, '.git', 'packed-refs'), 'utf8');
          const oursPacked = await readFile(path.join(ours, '.git', 'packed-refs'), 'utf8');
          expect(oursPacked).toBe(peerPacked);
          expect(oursPacked).toBe('# pack-refs with: peeled fully-peeled sorted \n');
        });
      });
    });

    describe('Given a packed-refs file with a malformed line', () => {
      describe('When a delete is attempted', () => {
        it('Then both refuse and neither file changes', async () => {
          // Arrange
          const { peer, ours, ctx } = await filesCasePair('malformed-packed-refs');
          const malformed = `# pack-refs with: peeled fully-peeled sorted \nnot-a-line\n`;
          await writeFile(path.join(peer, '.git', 'packed-refs'), malformed);
          await writeFile(path.join(ours, '.git', 'packed-refs'), malformed);

          // Act
          const gitResult = tryRunGitWithExit(['-C', peer, 'update-ref', '-d', 'refs/heads/p1']);
          let caught: unknown;
          try {
            await updateRef(ctx, branchRef('p1'), ZERO, { delete: true });
            expect.unreachable();
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(gitResult.exitCode).toBe(128);
          expect((caught as TsgitError).data.code).toBe('INVALID_PACKED_REFS');
          const peerPacked = await readFile(path.join(peer, '.git', 'packed-refs'), 'utf8');
          const oursPacked = await readFile(path.join(ours, '.git', 'packed-refs'), 'utf8');
          expect(peerPacked).toBe(malformed);
          expect(oursPacked).toBe(malformed);
        });
      });
    });

    describe('Given both an existing-ref lock and an absent-ref lock', () => {
      describe('When a delete is attempted on each', () => {
        it('Then git and tsgit both refuse cannot-lock-ref', async () => {
          // Arrange
          const { peer, ours, ctx } = await filesCasePair('lock-shapes');
          await writeFile(path.join(peer, '.git', 'refs', 'heads', 'b.lock'), '');
          await writeFile(path.join(ours, '.git', 'refs', 'heads', 'b.lock'), '');
          await writeFile(path.join(peer, '.git', 'refs', 'heads', 'ab.lock'), '');
          await writeFile(path.join(ours, '.git', 'refs', 'heads', 'ab.lock'), '');

          // Act + Assert — existing name
          const gitExisting = tryRunGitWithExit(['-C', peer, 'update-ref', '-d', 'refs/heads/b']);
          expect(gitExisting.exitCode).not.toBe(0);
          let caught: unknown;
          try {
            await updateRef(ctx, branchRef('b'), ZERO, { delete: true });
            expect.unreachable();
          } catch (err) {
            caught = err;
          }
          expect((caught as TsgitError).data.code).toBe('REF_LOCKED');

          // Act + Assert — absent name
          const gitAbsent = tryRunGitWithExit(['-C', peer, 'update-ref', '-d', 'refs/heads/ab']);
          expect(gitAbsent.exitCode).not.toBe(0);
          try {
            await updateRef(ctx, branchRef('ab'), ZERO, { delete: true });
            expect.unreachable();
          } catch (err) {
            caught = err;
          }
          expect((caught as TsgitError).data.code).toBe('REF_LOCKED');
        });
      });
    });

    describe('Given a nested absent ref name under directories that do not exist', () => {
      describe('When it is deleted', () => {
        it('Then git and tsgit both succeed and leave no intermediate directory', async () => {
          // Arrange
          const { peer, ours, ctx } = await filesCasePair('nested-absent-delete');

          // Act
          const gitResult = tryRunGitWithExit([
            '-C',
            peer,
            'update-ref',
            '-d',
            'refs/heads/deep/er/absent',
          ]);
          await updateRef(ctx, 'refs/heads/deep/er/absent' as RefName, ZERO, { delete: true });

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(await pathExists(path.join(peer, '.git', 'refs', 'heads', 'deep'))).toBe(false);
          expect(await pathExists(path.join(ours, '.git', 'refs', 'heads', 'deep'))).toBe(false);
        });
      });
    });

    describe('Given a packed-only remote-tracking ref (the shape fetch --prune deletes)', () => {
      describe('When it is deleted', () => {
        it("Then packed-refs matches git's own `fetch --prune` packed-only removal byte-for-byte", async () => {
          // Arrange — proves the same rewrite `fetch.ts`'s own `prune()`
          // drives through `updateRef` (unit-tested in fetch.test.ts, which
          // proves the caller no longer refuses or warns) matches git's own
          // `fetch --prune` packed-only-ref removal, without spinning a live
          // smart-HTTP server: a clone whose tracking ref is packed-only,
          // pruned locally by each side.
          const clonePeer = await cloneRepo(filesBase, 'prune-shape-peer');
          const cloneOurs = await cloneRepo(filesBase, 'prune-shape-ours');
          for (const dir of [clonePeer, cloneOurs]) {
            runGit(['-C', dir, 'update-ref', 'refs/remotes/origin/gone', filesC1]);
            git(dir, 'pack-refs', '--include', 'refs/remotes/origin/gone');
          }
          const trackingRef = 'refs/remotes/origin/gone' as RefName;

          // Act
          const gitResult = tryRunGitWithExit([
            '-C',
            clonePeer,
            'update-ref',
            '-d',
            'refs/remotes/origin/gone',
          ]);
          await updateRef(nodeCtx(cloneOurs), trackingRef, ZERO, { delete: true });

          // Assert
          expect(gitResult.exitCode).toBe(0);
          const peerPacked = await readFile(path.join(clonePeer, '.git', 'packed-refs'), 'utf8');
          const oursPacked = await readFile(path.join(cloneOurs, '.git', 'packed-refs'), 'utf8');
          expect(oursPacked).toBe(peerPacked);
          expect(oursPacked).not.toContain('refs/remotes/origin/gone');
        });
      });
    });

    describe('Given packed-only, fetch-logged and loose-over-packed tracking refs', () => {
      describe('When the remote is renamed', () => {
        it('Then packed-refs, every moved ref, and every reflog match git exactly, including the symbolic HEAD', async () => {
          // Arrange — GIT_COMMITTER_NAME/EMAIL, not repository config: git's
          // own `remote rename` does not read `user.name`/`user.email` for
          // its rename entries — `ours` carries the same identity via its
          // config's `[user]` instead, so both sides produce the same bytes.
          const { peer, ours, ctx } = await remoteRenameCasePair('remote-rename');
          const renameEnv: NodeJS.ProcessEnv = {
            ...runGitEnv(),
            GIT_COMMITTER_NAME: 'A',
            GIT_COMMITTER_EMAIL: 'a@x',
          };

          // Act
          const gitResult = tryRunGitWithExit(['-C', peer, 'remote', 'rename', 'origin', 'up2'], {
            env: renameEnv,
          });
          const result = await remoteRename(ctx, { from: 'origin', to: 'up2' });

          // Assert — packed-refs collapses to just refs/heads/main (every
          // tracking ref moved loose, as git's own rewrite does), and every
          // tracking ref including the symbolic HEAD is reported moved.
          expect(gitResult.exitCode).toBe(0);
          expect([...result.movedTrackingRefs].sort()).toEqual(
            [
              'refs/remotes/up2/HEAD',
              'refs/remotes/up2/keep',
              'refs/remotes/up2/lp',
              'refs/remotes/up2/main',
              'refs/remotes/up2/pl',
            ].sort(),
          );
          const peerPacked = await readFile(path.join(peer, '.git', 'packed-refs'), 'utf8');
          const oursPacked = await readFile(path.join(ours, '.git', 'packed-refs'), 'utf8');
          expect(oursPacked).toBe(peerPacked);
          expect(peerPacked).not.toContain('refs/remotes/');
          for (const name of ['keep', 'lp', 'main', 'pl']) {
            const peerValue = (
              await readFile(path.join(peer, '.git', 'refs', 'remotes', 'up2', name), 'utf8')
            ).trim();
            const oursValue = (
              await readFile(path.join(ours, '.git', 'refs', 'remotes', 'up2', name), 'utf8')
            ).trim();
            expect(oursValue).toBe(peerValue);
          }
          // git moves every tracking ref including the symbolic origin/HEAD —
          // nothing survives under refs/remotes/origin/ on either side.
          expect(await pathExists(path.join(peer, '.git', 'refs', 'remotes', 'origin'))).toBe(
            false,
          );
          expect(await pathExists(path.join(ours, '.git', 'refs', 'remotes', 'origin'))).toBe(
            false,
          );
          // The symbolic HEAD itself: same target on both sides, rewritten
          // onto the new remote namespace.
          const peerSymShow = tryRunGitWithExit([
            '-C',
            peer,
            'symbolic-ref',
            'refs/remotes/up2/HEAD',
          ]);
          expect(peerSymShow.exitCode).toBe(0);
          expect(peerSymShow.stdout.trim()).toBe('refs/remotes/up2/main');
          expect(await getRefStore(ctx).resolveDirect('refs/remotes/up2/HEAD' as RefName)).toEqual({
            kind: 'symbolic',
            target: 'refs/remotes/up2/main',
          });
          // keep/main: packed-only, never fetched into individually — no log
          // ever existed, and the rename creates none.
          for (const name of ['keep', 'main']) {
            expect(
              await pathExists(path.join(peer, '.git', 'logs', 'refs', 'remotes', 'up2', name)),
            ).toBe(false);
            expect(
              await pathExists(path.join(ours, '.git', 'logs', 'refs', 'remotes', 'up2', name)),
            ).toBe(false);
          }
          // lp, pl, HEAD: every fetch-built log line, byte-for-byte, plus the
          // rename's own trailing entry.
          for (const name of ['lp', 'pl', 'HEAD']) {
            const peerLog = await readFile(
              path.join(peer, '.git', 'logs', 'refs', 'remotes', 'up2', name),
              'utf8',
            );
            const oursLog = await readFile(
              path.join(ours, '.git', 'logs', 'refs', 'remotes', 'up2', name),
              'utf8',
            );
            expect(oursLog).toBe(peerLog);
          }
          // No log survives under the old namespace.
          expect(
            await pathExists(path.join(peer, '.git', 'logs', 'refs', 'remotes', 'origin')),
          ).toBe(false);
          expect(
            await pathExists(path.join(ours, '.git', 'logs', 'refs', 'remotes', 'origin')),
          ).toBe(false);
        });
      });
    });

    describe('Given a reftable-base clone with a fetched tracking branch and a symbolic origin/HEAD', () => {
      describe('When the remote is renamed', () => {
        it('Then every moved ref, its reflog, and the kept origin/HEAD log match git exactly after migrating both sides to files', async () => {
          // Arrange — a bare upstream and a source repo pushing two commits,
          // fetched twice into a reftable-format clone so `origin/main` gets
          // two real log lines (clone, then fast-forward) and `origin/HEAD`
          // gets its own clone-time entry. Reftable has no packed/loose
          // split, so this fixture only needs the one tracking branch plus
          // the symref — the files-backend row above covers the packed and
          // loose shapes that don't apply here.
          const upstream = await mkdtemp(
            path.join(os.tmpdir(), 'tsgit-ref-transaction-rt-rename-up-'),
          );
          caseRoots.push(upstream);
          runGit(['init', '-q', '--bare', '-b', 'main', upstream]);
          const src = await mkdtemp(path.join(os.tmpdir(), 'tsgit-ref-transaction-rt-rename-src-'));
          caseRoots.push(src);
          runGit(['init', '-q', '-b', 'main', src]);
          git(src, 'config', 'user.name', 'A');
          git(src, 'config', 'user.email', 'a@x');
          git(src, 'config', 'commit.gpgsign', 'false');
          disableAutoMaintenance(src);
          await writeFile(path.join(src, 'f.txt'), 'c1\n');
          git(src, 'add', '-A');
          runGit(['-C', src, 'commit', '-q', '-m', 'c1'], {
            env: pinnedEnv(COMMITTER_EPOCH + 200),
          });
          runGit(['-C', src, 'remote', 'add', 'origin', upstream]);
          runGit(['-C', src, 'push', '-q', 'origin', 'main'], {
            env: pinnedEnv(COMMITTER_EPOCH + 200),
          });
          const rtRenameBase = await mkdtemp(
            path.join(os.tmpdir(), 'tsgit-ref-transaction-rt-rename-base-'),
          );
          caseRoots.push(rtRenameBase);
          runGit(['clone', '-q', '--ref-format=reftable', upstream, rtRenameBase], {
            env: pinnedEnv(COMMITTER_EPOCH + 201),
          });
          git(rtRenameBase, 'config', 'user.name', 'A');
          git(rtRenameBase, 'config', 'user.email', 'a@x');
          disableAutoMaintenance(rtRenameBase);
          await writeFile(path.join(src, 'f.txt'), 'c2\n');
          git(src, 'add', '-A');
          runGit(['-C', src, 'commit', '-q', '-m', 'c2'], {
            env: pinnedEnv(COMMITTER_EPOCH + 202),
          });
          runGit(['-C', src, 'push', '-q', 'origin', 'main'], {
            env: pinnedEnv(COMMITTER_EPOCH + 202),
          });
          runGit(['-C', rtRenameBase, 'fetch', '-q', 'origin'], {
            env: pinnedEnv(COMMITTER_EPOCH + 203),
          });
          const peer = await cloneRepo(rtRenameBase, 'rt-rename-peer');
          const ours = await cloneRepo(rtRenameBase, 'rt-rename-ours');
          const ctx = withReftableStorage(nodeCtx(ours));

          // Act
          const gitResult = tryRunGitWithExit(['-C', peer, 'remote', 'rename', 'origin', 'up2'], {
            env: {
              ...runGitEnv(),
              GIT_COMMITTER_NAME: 'A',
              GIT_COMMITTER_EMAIL: 'a@x',
              GIT_COMMITTER_DATE: `${COMMITTER_EPOCH + 204} +0000`,
            },
          });
          const dateSpy = vi.spyOn(Date, 'now').mockReturnValue((COMMITTER_EPOCH + 204) * 1000);
          try {
            await remoteRename(ctx, { from: 'origin', to: 'up2' });
          } finally {
            dateSpy.mockRestore();
          }
          runGit(['-C', peer, 'refs', 'migrate', '--ref-format=files']);
          runGit(['-C', ours, 'refs', 'migrate', '--ref-format=files']);

          // Assert
          expect(gitResult.exitCode).toBe(0);
          // up2/main: the moved history (clone + fetch) plus the rename's
          // own same-id entry.
          const peerMainLog = await readFile(
            path.join(peer, '.git', 'logs', 'refs', 'remotes', 'up2', 'main'),
            'utf8',
          );
          const oursMainLog = await readFile(
            path.join(ours, '.git', 'logs', 'refs', 'remotes', 'up2', 'main'),
            'utf8',
          );
          expect(oursMainLog).toBe(peerMainLog);
          expect(peerMainLog.trim().split('\n')).toHaveLength(3);
          // up2/HEAD: the copied clone-time history, with NO trailing entry
          // — the reftable create side never gets one.
          const peerHeadLog = await readFile(
            path.join(peer, '.git', 'logs', 'refs', 'remotes', 'up2', 'HEAD'),
            'utf8',
          );
          const oursHeadLog = await readFile(
            path.join(ours, '.git', 'logs', 'refs', 'remotes', 'up2', 'HEAD'),
            'utf8',
          );
          expect(oursHeadLog).toBe(peerHeadLog);
          expect(peerHeadLog.trim().split('\n')).toHaveLength(1);
          // origin/HEAD: no live ref, but its log survives (an orphan, like
          // any other moved-away name) with ONE new entry appended — the
          // referent's LAST value before the rename, to the null id, no
          // message.
          expect(await pathExists(path.join(peer, '.git', 'refs', 'remotes', 'origin'))).toBe(
            false,
          );
          expect(await pathExists(path.join(ours, '.git', 'refs', 'remotes', 'origin'))).toBe(
            false,
          );
          const peerOrphanLog = await readFile(
            path.join(peer, '.git', 'logs', 'refs', 'remotes', 'origin', 'HEAD'),
            'utf8',
          );
          const oursOrphanLog = await readFile(
            path.join(ours, '.git', 'logs', 'refs', 'remotes', 'origin', 'HEAD'),
            'utf8',
          );
          expect(oursOrphanLog).toBe(peerOrphanLog);
          expect(peerOrphanLog.trim().split('\n')).toHaveLength(2);
          expect(peerOrphanLog).toContain(`${ZERO} A <a@x>`);
          expect(peerOrphanLog.trimEnd().endsWith(`+0000`)).toBe(true);
        });
      });
    });

    describe('Given a symbolic ref', () => {
      describe('When it is deleted by its own name', () => {
        it('Then both git and tsgit dereference: the target is gone, the symref itself survives', async () => {
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

          // tsgit: the symref FILE survives (still symbolic to `x`); the
          // target is gone — matching git exactly.
          expect(await pathExists(path.join(ours, '.git', 'refs', 'heads', 'sym'))).toBe(true);
          expect(await getRefStore(ctx).resolveDirect(branchRef('sym'))).toEqual({
            kind: 'symbolic',
            target: branchRef('x'),
          });
          const target = await getRefStore(ctx).resolveDirect(branchRef('x'));
          expect(target).toEqual({ kind: 'missing' });
        });
      });
    });

    describe('Given HEAD symbolically points at the branch being deleted', () => {
      describe('When it is deleted with -m why', () => {
        it('Then logs/HEAD gains the identical appended entry on both sides', async () => {
          // Arrange — main is HEAD's target in the shared base.
          const { peer, ours, ctx } = await filesCasePair('head-entry-with-message');
          const dateSpy = vi.spyOn(Date, 'now').mockReturnValue((COMMITTER_EPOCH + 10) * 1000);

          // Act
          try {
            runGit(['-C', peer, 'update-ref', '-d', '-m', 'why', 'refs/heads/main'], {
              env: pinnedEnv(COMMITTER_EPOCH + 10),
            });
            await updateRef(ctx, branchRef('main'), ZERO, { delete: true, reflogMessage: 'why' });
          } finally {
            dateSpy.mockRestore();
          }

          // Assert — git's logs/HEAD gains `<old> 0{40} why`; both sides
          // byte-identical.
          const gitHeadLog = await readFile(path.join(peer, '.git', 'logs', 'HEAD'), 'utf8');
          const oursHeadLog = await readFile(path.join(ours, '.git', 'logs', 'HEAD'), 'utf8');
          expect(gitHeadLog).toContain('why');
          expect(oursHeadLog).toBe(gitHeadLog);
        });
      });

      describe('When it is deleted with no -m', () => {
        it('Then logs/HEAD gains an identical entry with no tab (empty message)', async () => {
          // Arrange
          const { peer, ours, ctx } = await filesCasePair('head-entry-no-message');
          const dateSpy = vi.spyOn(Date, 'now').mockReturnValue((COMMITTER_EPOCH + 11) * 1000);

          // Act
          try {
            runGit(['-C', peer, 'update-ref', '-d', 'refs/heads/main'], {
              env: pinnedEnv(COMMITTER_EPOCH + 11),
            });
            await updateRef(ctx, branchRef('main'), ZERO, { delete: true });
          } finally {
            dateSpy.mockRestore();
          }

          // Assert
          const gitHeadLog = await readFile(path.join(peer, '.git', 'logs', 'HEAD'), 'utf8');
          const oursHeadLog = await readFile(path.join(ours, '.git', 'logs', 'HEAD'), 'utf8');
          expect(oursHeadLog).toBe(gitHeadLog);
        });
      });
    });

    describe('Given a fresh repository whose HEAD points at an unborn branch', () => {
      describe('When that branch is deleted', () => {
        it('Then git and tsgit both create logs/HEAD with an identical 0{40} 0{40} entry', async () => {
          // Arrange
          const peerRoot = await mkdtemp(
            path.join(os.tmpdir(), 'tsgit-ref-transaction-unborn-peer-'),
          );
          runGit(['init', '-q', '-b', 'main', peerRoot]);
          git(peerRoot, 'config', 'user.name', 'A');
          git(peerRoot, 'config', 'user.email', 'a@x');
          disableAutoMaintenance(peerRoot);
          const oursRoot = await mkdtemp(
            path.join(os.tmpdir(), 'tsgit-ref-transaction-unborn-ours-'),
          );
          runGit(['init', '-q', '-b', 'main', oursRoot]);
          git(oursRoot, 'config', 'user.name', 'A');
          git(oursRoot, 'config', 'user.email', 'a@x');
          disableAutoMaintenance(oursRoot);
          const dateSpy = vi.spyOn(Date, 'now').mockReturnValue((COMMITTER_EPOCH + 12) * 1000);

          // Act
          try {
            runGit(['-C', peerRoot, 'update-ref', '-d', '-m', 'unborn', 'refs/heads/main'], {
              env: pinnedEnv(COMMITTER_EPOCH + 12),
            });
            await updateRef(nodeCtx(oursRoot), branchRef('main'), ZERO, {
              delete: true,
              reflogMessage: 'unborn',
            });
          } finally {
            dateSpy.mockRestore();
          }

          // Assert
          const gitHeadLog = await readFile(path.join(peerRoot, '.git', 'logs', 'HEAD'), 'utf8');
          const oursHeadLog = await readFile(path.join(oursRoot, '.git', 'logs', 'HEAD'), 'utf8');
          expect(gitHeadLog).toContain(`${ZERO} ${ZERO}`);
          expect(oursHeadLog).toBe(gitHeadLog);
          await Promise.all([
            rm(peerRoot, { recursive: true, force: true }),
            rm(oursRoot, { recursive: true, force: true }),
          ]);
        });
      });
    });

    describe('Given a fresh reftable repository whose HEAD points at an unborn branch', () => {
      describe('When that branch is deleted', () => {
        it('Then neither git nor tsgit write a HEAD entry — the reftable backend skips the no-op delete log', async () => {
          // Arrange — git's own reftable repository proves it writes NO
          // `log -g HEAD` history at all; tsgit's primitive is proven
          // separately on an equivalent fresh reftable repo, since there is
          // no `git refs migrate` shortcut for reading a reftable HEAD log
          // directly.
          const peerRoot = await mkdtemp(
            path.join(os.tmpdir(), 'tsgit-ref-transaction-unborn-reftable-peer-'),
          );
          runGit(['init', '-q', '-b', 'main', '--ref-format=reftable', peerRoot]);
          git(peerRoot, 'config', 'user.name', 'A');
          git(peerRoot, 'config', 'user.email', 'a@x');
          disableAutoMaintenance(peerRoot);
          const oursRoot = await mkdtemp(
            path.join(os.tmpdir(), 'tsgit-ref-transaction-unborn-reftable-ours-'),
          );
          runGit(['init', '-q', '-b', 'main', '--ref-format=reftable', oursRoot]);

          // Act
          const gitResult = tryRunGitWithExit([
            '-C',
            peerRoot,
            'update-ref',
            '-d',
            '-m',
            'unborn',
            'refs/heads/main',
          ]);
          const oursCtx = withReftableStorage(createNodeContext({ workDir: oursRoot }));
          await updateRef(oursCtx, branchRef('main'), ZERO, {
            delete: true,
            reflogMessage: 'unborn',
          });

          // Assert — git's own `log -g HEAD` refuses (no history at all);
          // tsgit's primitive reads the same emptiness through its own API.
          expect(gitResult.exitCode).toBe(0);
          const peerLog = tryRunGitWithExit(['-C', peerRoot, 'log', '-g', '--format=%H', 'HEAD']);
          expect(peerLog.exitCode).not.toBe(0);
          expect(await getRefStore(oursCtx).readReflog('HEAD' as RefName)).toEqual([]);
          await Promise.all([
            rm(peerRoot, { recursive: true, force: true }),
            rm(oursRoot, { recursive: true, force: true }),
          ]);
        });
      });
    });

    describe('Given a packed-only branch that HEAD points at', () => {
      describe('When it is deleted', () => {
        it('Then packed-refs collapses to the header alone and logs/HEAD gains the identical entry on both sides', async () => {
          // Arrange — a dedicated small repo: `main` is HEAD's target and
          // the ONLY packed ref, so its delete leaves packed-refs header-only.
          const peerRoot = await mkdtemp(
            path.join(os.tmpdir(), 'tsgit-ref-transaction-packed-head-peer-'),
          );
          runGit(['init', '-q', '-b', 'main', peerRoot]);
          git(peerRoot, 'config', 'user.name', 'A');
          git(peerRoot, 'config', 'user.email', 'a@x');
          disableAutoMaintenance(peerRoot);
          await writeFile(path.join(peerRoot, 'f.txt'), 'c1\n');
          git(peerRoot, 'add', '-A');
          runGit(['-C', peerRoot, 'commit', '-q', '-m', 'c1'], {
            env: pinnedEnv(COMMITTER_EPOCH + 20),
          });
          git(peerRoot, 'pack-refs', '--all');
          const oursRoot = await cloneRepo(peerRoot, 'packed-head-ours');
          const dateSpy = vi.spyOn(Date, 'now').mockReturnValue((COMMITTER_EPOCH + 21) * 1000);

          // Act
          try {
            runGit(['-C', peerRoot, 'update-ref', '-d', '-m', 'pack-del', 'refs/heads/main'], {
              env: pinnedEnv(COMMITTER_EPOCH + 21),
            });
            await updateRef(nodeCtx(oursRoot), branchRef('main'), ZERO, {
              delete: true,
              reflogMessage: 'pack-del',
            });
          } finally {
            dateSpy.mockRestore();
          }

          // Assert
          const gitPacked = await readFile(path.join(peerRoot, '.git', 'packed-refs'), 'utf8');
          const oursPacked = await readFile(path.join(oursRoot, '.git', 'packed-refs'), 'utf8');
          expect(gitPacked).toBe('# pack-refs with: peeled fully-peeled sorted \n');
          expect(oursPacked).toBe(gitPacked);
          const gitHeadLog = await readFile(path.join(peerRoot, '.git', 'logs', 'HEAD'), 'utf8');
          const oursHeadLog = await readFile(path.join(oursRoot, '.git', 'logs', 'HEAD'), 'utf8');
          expect(gitHeadLog).toContain('pack-del');
          expect(oursHeadLog).toBe(gitHeadLog);
          await rm(peerRoot, { recursive: true, force: true });
        });
      });
    });

    describe('Given a loose ref file refs/remotes/q in the way of a packed ref refs/remotes/q/z', () => {
      /** Packs `refs/remotes/q/z` with git, then plants the loose file `refs/remotes/q`. */
      const seedInTheWay = async (dir: string): Promise<void> => {
        runGit(['-C', dir, 'update-ref', 'refs/remotes/q/z', filesC1]);
        git(dir, 'pack-refs', '--include', 'refs/remotes/q/z');
        await writeFile(path.join(dir, '.git', 'refs', 'remotes', 'q'), `${filesC1}\n`);
      };

      describe('When git and tsgit delete or write under refs/remotes/q', () => {
        it.each([
          {
            label: 'deleting refs/remotes/q/z',
            gitArgs: ['update-ref', '-d', 'refs/remotes/q/z'],
            gitExit: 1,
            name: 'refs/remotes/q/z',
            remove: true,
          },
          {
            label: 'writing refs/remotes/q/new',
            gitArgs: ['update-ref', 'refs/remotes/q/new'],
            gitExit: 128,
            name: 'refs/remotes/q/new',
            remove: false,
          },
        ])(
          'Then $label refuses on both before anything changes on disk',
          async ({ gitArgs, gitExit, name, remove }) => {
            // Arrange
            const { peer, ours, ctx } = await filesCasePair(`df-${remove ? 'delete' : 'write'}`);
            await seedInTheWay(peer);
            await seedInTheWay(ours);
            const packedBefore = await readFile(path.join(ours, '.git', 'packed-refs'), 'utf8');
            const sut = updateRef;

            // Act
            const gitResult = tryRunGitWithExit(
              ['-C', peer, ...gitArgs, ...(remove ? [] : [filesC1])],
              { env: runGitEnv() },
            );
            let caught: unknown;
            try {
              await sut(
                ctx,
                name as RefName,
                remove ? ZERO : (filesC1 as ObjectId),
                remove ? { delete: true } : { reflogMessage: 'm' },
              );
            } catch (err) {
              caught = err;
            }

            // Assert
            expect(gitResult.exitCode).toBe(gitExit);
            expect(gitResult.stderr).toContain(`'refs/remotes/q' exists; cannot create '${name}'`);
            expect((caught as TsgitError).data).toEqual({
              code: 'NOT_A_DIRECTORY',
              path: `${ctx.layout.gitDir}/refs/remotes/q`,
            });
            expect(await readFile(path.join(ours, '.git', 'packed-refs'), 'utf8')).toBe(
              packedBefore,
            );
            expect(await pathExists(path.join(ours, '.git', 'packed-refs.lock'))).toBe(false);
            expect(await readFile(path.join(ours, '.git', 'refs', 'remotes', 'q'), 'utf8')).toBe(
              `${filesC1}\n`,
            );
          },
        );
      });
    });

    describe('Given refs under refs/remotes/d on both tools', () => {
      /** `d` packed and `d/x` loose: git packs a stand-in name, the line is
       *  renamed to `d`, then `d/x` is planted as a loose file. */
      const seedPackedOverLoose = async (dir: string): Promise<void> => {
        runGit(['-C', dir, 'update-ref', 'refs/remotes/placeholder', filesC1]);
        git(dir, 'pack-refs', '--include', 'refs/remotes/placeholder');
        const packedPath = path.join(dir, '.git', 'packed-refs');
        const packed = await readFile(packedPath, 'utf8');
        await writeFile(
          packedPath,
          packed.replace('refs/remotes/placeholder\n', 'refs/remotes/d\n'),
        );
        await mkdir(path.join(dir, '.git', 'refs', 'remotes', 'd'), { recursive: true });
        await writeFile(path.join(dir, '.git', 'refs', 'remotes', 'd', 'x'), `${filesC2}\n`);
      };
      const seedLooseUnder = async (dir: string): Promise<void> => {
        runGit(['-C', dir, 'update-ref', 'refs/remotes/d/x', filesC2]);
      };
      const seedPackedUnder = async (dir: string): Promise<void> => {
        runGit(['-C', dir, 'update-ref', 'refs/remotes/d/x', filesC2]);
        git(dir, 'pack-refs', '--include', 'refs/remotes/d/x');
      };

      describe('When git rev-parse and tsgit resolveRef read the packed refs/remotes/d', () => {
        it('Then both resolve the packed value past the loose directory', async () => {
          // Arrange
          const { peer, ours, ctx } = await filesCasePair('rdf-read');
          await seedPackedOverLoose(peer);
          await seedPackedOverLoose(ours);
          const sut = getRefStore(ctx);

          // Act
          const result = await sut.resolveDirect('refs/remotes/d' as RefName);

          // Assert
          const gitResult = tryRunGitWithExit(
            ['-C', peer, 'rev-parse', '--verify', 'refs/remotes/d'],
            {
              env: runGitEnv(),
            },
          );
          expect(gitResult.exitCode).toBe(0);
          expect(result).toEqual({ kind: 'direct', id: gitResult.stdout.trim() });
        });
      });

      describe('When git and tsgit delete the packed refs/remotes/d over the loose directory', () => {
        it('Then both succeed with identical packed-refs and the loose ref under it kept', async () => {
          // Arrange
          const { peer, ours, ctx } = await filesCasePair('rdf-delete');
          await seedPackedOverLoose(peer);
          await seedPackedOverLoose(ours);
          const sut = updateRef;

          // Act
          const gitResult = tryRunGitWithExit(['-C', peer, 'update-ref', '-d', 'refs/remotes/d'], {
            env: runGitEnv(),
          });
          await sut(ctx, 'refs/remotes/d' as RefName, ZERO, { delete: true });

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(await readFile(path.join(ours, '.git', 'packed-refs'), 'utf8')).toBe(
            await readFile(path.join(peer, '.git', 'packed-refs'), 'utf8'),
          );
          expect(await readFile(path.join(ours, '.git', 'refs', 'remotes', 'd', 'x'), 'utf8')).toBe(
            `${filesC2}\n`,
          );
          expect(await pathExists(path.join(ours, '.git', 'refs', 'remotes', 'd.lock'))).toBe(
            false,
          );
        });
      });

      describe('When git and tsgit write refs/remotes/d over a ref under it', () => {
        it.each([
          { label: 'a loose ref under it', slug: 'rdf-write-loose', seedUnder: seedLooseUnder },
          {
            label: 'a packed-only ref under it',
            slug: 'rdf-write-packed',
            seedUnder: seedPackedUnder,
          },
        ])(
          'Then both refuse over $label before anything changes on disk',
          async ({ slug, seedUnder }) => {
            // Arrange
            const { peer, ours, ctx } = await filesCasePair(slug);
            await seedUnder(peer);
            await seedUnder(ours);
            const packedBefore = await readFile(path.join(ours, '.git', 'packed-refs'), 'utf8');
            const sut = updateRef;

            // Act
            const gitResult = tryRunGitWithExit(
              ['-C', peer, 'update-ref', 'refs/remotes/d', filesC1],
              { env: runGitEnv() },
            );
            let caught: unknown;
            try {
              await sut(ctx, 'refs/remotes/d' as RefName, filesC1 as ObjectId, {
                reflogMessage: 'm',
              });
            } catch (err) {
              caught = err;
            }

            // Assert
            expect(gitResult.exitCode).toBe(128);
            expect(gitResult.stderr).toContain(
              "'refs/remotes/d/x' exists; cannot create 'refs/remotes/d'",
            );
            expect((caught as TsgitError).data).toEqual({
              code: 'FILE_EXISTS',
              path: `${ctx.layout.gitDir}/refs/remotes/d/x`,
            });
            expect(await readFile(path.join(ours, '.git', 'packed-refs'), 'utf8')).toBe(
              packedBefore,
            );
            expect(await pathExists(path.join(ours, '.git', 'refs', 'remotes', 'd.lock'))).toBe(
              false,
            );
          },
        );
      });
    });

    describe('Given refs/heads/lnk is a symbolic link whose text is refs/heads/x on both tools', () => {
      const plantLink = (dir: string): Promise<void> =>
        symlink('refs/heads/x', path.join(dir, '.git', 'refs', 'heads', 'lnk'));
      const logOf = (dir: string, name: string): Promise<string> =>
        readFile(path.join(dir, '.git', 'logs', 'refs', 'heads', name), 'utf8');
      const isLink = async (dir: string): Promise<boolean> =>
        (await lstat(path.join(dir, '.git', 'refs', 'heads', 'lnk'))).isSymbolicLink();

      describe('When git symbolic-ref and for-each-ref read it and tsgit resolves and lists it', () => {
        it('Then both report a symref to refs/heads/x and neither lists the dangling path', async () => {
          // Arrange
          const { peer, ours, ctx } = await filesCasePair('link-read');
          await plantLink(peer);
          await plantLink(ours);
          const sut = getRefStore(ctx);

          // Act
          const result = await sut.resolveDirect(branchRef('lnk'));
          const names = await sut.listRefNames('refs/heads/' as RefName);

          // Assert
          const gitSymref = tryRunGitWithExit(['-C', peer, 'symbolic-ref', 'refs/heads/lnk'], {
            env: runGitEnv(),
          });
          const gitList = tryRunGitWithExit(
            ['-C', peer, 'for-each-ref', '--format=%(refname)', 'refs/heads/'],
            { env: runGitEnv() },
          );
          expect(gitSymref.stdout.trim()).toBe('refs/heads/x');
          expect(result).toEqual({ kind: 'symbolic', target: branchRef('x') });
          expect(names).toEqual(gitList.stdout.trim().split('\n'));
        });
      });

      describe('When both write it dereferencing', () => {
        it('Then x moves, the link stays, and both logs are byte-identical', async () => {
          // Arrange
          const { peer, ours, ctx } = await filesCasePair('link-write');
          await plantLink(peer);
          await plantLink(ours);
          const dateSpy = vi.spyOn(Date, 'now').mockReturnValue((COMMITTER_EPOCH + 30) * 1000);
          const sut = updateRef;

          // Act
          try {
            runGit(['-C', peer, 'update-ref', '-m', 'w', 'refs/heads/lnk', filesC1], {
              env: pinnedEnv(COMMITTER_EPOCH + 30),
            });
            await sut(ctx, branchRef('lnk'), filesC1 as ObjectId, { reflogMessage: 'w' });
          } finally {
            dateSpy.mockRestore();
          }

          // Assert
          expect(git(peer, 'rev-parse', 'refs/heads/x').trim()).toBe(filesC1);
          expect(await getRefStore(ctx).resolveDirect(branchRef('x'))).toEqual({
            kind: 'direct',
            id: filesC1,
          });
          expect(await isLink(peer)).toBe(true);
          expect(await isLink(ours)).toBe(true);
          expect(await logOf(ours, 'x')).toBe(await logOf(peer, 'x'));
          expect(await logOf(ours, 'lnk')).toBe(await logOf(peer, 'lnk'));
        });
      });

      describe('When both write it without dereferencing', () => {
        it('Then the link becomes the same regular file with the same log on both', async () => {
          // Arrange
          const { peer, ours, ctx } = await filesCasePair('link-no-deref-write');
          await plantLink(peer);
          await plantLink(ours);
          const dateSpy = vi.spyOn(Date, 'now').mockReturnValue((COMMITTER_EPOCH + 31) * 1000);
          const sut = updateRef;

          // Act
          try {
            runGit(
              ['-C', peer, 'update-ref', '--no-deref', '-m', 'nd', 'refs/heads/lnk', filesC1],
              { env: pinnedEnv(COMMITTER_EPOCH + 31) },
            );
            await sut(ctx, branchRef('lnk'), filesC1 as ObjectId, {
              reflogMessage: 'nd',
              noDeref: true,
            });
          } finally {
            dateSpy.mockRestore();
          }

          // Assert
          const loose = (dir: string): string => path.join(dir, '.git', 'refs', 'heads', 'lnk');
          expect(await isLink(peer)).toBe(false);
          expect(await isLink(ours)).toBe(false);
          expect(await readFile(loose(ours), 'utf8')).toBe(await readFile(loose(peer), 'utf8'));
          expect(await logOf(ours, 'lnk')).toBe(await logOf(peer, 'lnk'));
          expect(await logOf(ours, 'x')).toBe(await logOf(peer, 'x'));
        });
      });

      describe('When both delete it without dereferencing', () => {
        it('Then the link is gone and x is kept on both', async () => {
          // Arrange
          const { peer, ours, ctx } = await filesCasePair('link-no-deref-delete');
          await plantLink(peer);
          await plantLink(ours);
          const sut = updateRef;

          // Act
          const gitResult = tryRunGitWithExit(
            ['-C', peer, 'update-ref', '--no-deref', '-d', 'refs/heads/lnk'],
            { env: runGitEnv() },
          );
          await sut(ctx, branchRef('lnk'), ZERO, { delete: true, noDeref: true });

          // Assert
          expect(gitResult.exitCode).toBe(0);
          for (const dir of [peer, ours]) {
            expect(await pathExists(path.join(dir, '.git', 'refs', 'heads', 'lnk'))).toBe(false);
            expect(await readFile(path.join(dir, '.git', 'refs', 'heads', 'x'), 'utf8')).toBe(
              `${filesC2}\n`,
            );
          }
        });
      });
    });

    describe('Given a directory at refs/heads/e on both tools', () => {
      const refDir = (dir: string, ...rest: string[]): string =>
        path.join(dir, '.git', 'refs', 'heads', 'e', ...rest);

      describe('When both write refs/heads/e over a tree of empty directories, its log path an empty directory too', () => {
        it('Then both remove the trees and write identical ref and log bytes', async () => {
          // Arrange
          const { peer, ours, ctx } = await filesCasePair('empty-dir-write');
          for (const dir of [peer, ours]) {
            await mkdir(refDir(dir, 'a', 'b'), { recursive: true });
            await mkdir(path.join(dir, '.git', 'logs', 'refs', 'heads', 'e', 'c'), {
              recursive: true,
            });
          }
          const dateSpy = vi.spyOn(Date, 'now').mockReturnValue((COMMITTER_EPOCH + 32) * 1000);
          const sut = updateRef;

          // Act
          try {
            runGit(['-C', peer, 'update-ref', '-m', 'w', 'refs/heads/e', filesC1], {
              env: pinnedEnv(COMMITTER_EPOCH + 32),
            });
            await sut(ctx, branchRef('e'), filesC1 as ObjectId, { reflogMessage: 'w' });
          } finally {
            dateSpy.mockRestore();
          }

          // Assert
          const log = (dir: string): Promise<string> =>
            readFile(path.join(dir, '.git', 'logs', 'refs', 'heads', 'e'), 'utf8');
          expect(await readFile(refDir(ours), 'utf8')).toBe(await readFile(refDir(peer), 'utf8'));
          expect(await log(ours)).toBe(await log(peer));
        });
      });

      describe('When both write refs/heads/e over a directory holding a lock file', () => {
        it('Then git refuses the blocking directory, tsgit refuses DIRECTORY_NOT_EMPTY, and both keep it', async () => {
          // Arrange
          const { peer, ours, ctx } = await filesCasePair('blocking-dir-write');
          for (const dir of [peer, ours]) {
            await mkdir(refDir(dir), { recursive: true });
            await writeFile(refDir(dir, 'x.lock'), '');
          }
          const sut = updateRef;

          // Act
          const gitResult = tryRunGitWithExit(['-C', peer, 'update-ref', 'refs/heads/e', filesC1], {
            env: runGitEnv(),
          });
          let caught: unknown;
          try {
            await sut(ctx, branchRef('e'), filesC1 as ObjectId, { reflogMessage: 'w' });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(gitResult.exitCode).toBe(128);
          expect(gitResult.stderr).toContain(
            "there is a non-empty directory '.git/refs/heads/e' blocking reference 'refs/heads/e'",
          );
          expect((caught as TsgitError).data).toEqual({
            code: 'DIRECTORY_NOT_EMPTY',
            path: `${ctx.layout.gitDir}/refs/heads/e`,
          });
          for (const dir of [peer, ours]) {
            expect(await pathExists(refDir(dir, 'x.lock'))).toBe(true);
          }
        });
      });

      describe('When both delete the absent refs/heads/e over a tree of empty directories', () => {
        it('Then both remove the tree', async () => {
          // Arrange
          const { peer, ours, ctx } = await filesCasePair('empty-dir-delete');
          for (const dir of [peer, ours]) await mkdir(refDir(dir, 'a'), { recursive: true });
          const sut = updateRef;

          // Act
          const gitResult = tryRunGitWithExit(['-C', peer, 'update-ref', '-d', 'refs/heads/e'], {
            env: runGitEnv(),
          });
          await sut(ctx, branchRef('e'), ZERO, { delete: true });

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(await pathExists(refDir(peer))).toBe(false);
          expect(await pathExists(refDir(ours))).toBe(false);
        });
      });

      describe('When both delete the absent refs/heads/e over a loose ref under it', () => {
        it('Then git refuses naming the ref under it, tsgit refuses FILE_EXISTS naming it, and both keep it', async () => {
          // Arrange
          const { peer, ours, ctx } = await filesCasePair('refs-under-delete');
          for (const dir of [peer, ours]) {
            runGit(['-C', dir, 'update-ref', 'refs/heads/e/x', filesC1]);
          }
          const sut = updateRef;

          // Act
          const gitResult = tryRunGitWithExit(['-C', peer, 'update-ref', '-d', 'refs/heads/e'], {
            env: runGitEnv(),
          });
          let caught: unknown;
          try {
            await sut(ctx, branchRef('e'), ZERO, { delete: true });
          } catch (err) {
            caught = err;
          }

          // Assert
          expect(gitResult.exitCode).toBe(1);
          expect(gitResult.stderr).toContain(
            "'refs/heads/e/x' exists; cannot create 'refs/heads/e'",
          );
          expect((caught as TsgitError).data).toEqual({
            code: 'FILE_EXISTS',
            path: `${ctx.layout.gitDir}/refs/heads/e/x`,
          });
          for (const dir of [peer, ours]) {
            expect(await readFile(refDir(dir, 'x'), 'utf8')).toBe(`${filesC1}\n`);
          }
        });
      });
    });

    describe('Given a transaction whose own names collide, on both tools and both backends', () => {
      type StdinUpdate = readonly ['create' | 'delete', string];
      interface CollisionRow {
        readonly label: string;
        readonly slug: string;
        readonly existing: readonly string[];
        readonly updates: readonly StdinUpdate[];
        readonly refusal: Readonly<Record<'files' | 'reftable', readonly [string, string, string]>>;
      }
      const remote = (short: string): RefName => `refs/remotes/${short}` as RefName;
      const same = (code: string, blocking: string, message: string) => ({
        files: [code, blocking, message] as const,
        reftable: [code, blocking, message] as const,
      });
      const ROWS: readonly CollisionRow[] = [
        {
          label: 'creating d while deleting the existing d/x',
          slug: 'create-delete-under',
          existing: ['d/x'],
          updates: [
            ['create', 'd'],
            ['delete', 'd/x'],
          ],
          refusal: same(
            'FILE_EXISTS',
            'd/x',
            "'refs/remotes/d/x' exists; cannot create 'refs/remotes/d'",
          ),
        },
        {
          label: 'deleting the existing d/x before creating d',
          slug: 'delete-under-create',
          existing: ['d/x'],
          updates: [
            ['delete', 'd/x'],
            ['create', 'd'],
          ],
          refusal: same(
            'FILE_EXISTS',
            'd/x',
            "'refs/remotes/d/x' exists; cannot create 'refs/remotes/d'",
          ),
        },
        {
          label: 'creating f and f/x together',
          slug: 'create-both',
          existing: [],
          updates: [
            ['create', 'f'],
            ['create', 'f/x'],
          ],
          refusal: same(
            'FILE_EXISTS',
            'f/x',
            "cannot process 'refs/remotes/f' and 'refs/remotes/f/x'",
          ),
        },
        {
          label: 'creating g/x before g',
          slug: 'create-child-first',
          existing: [],
          updates: [
            ['create', 'g/x'],
            ['create', 'g'],
          ],
          refusal: {
            files: ['FILE_EXISTS', 'g/x', "cannot process 'refs/remotes/g' and 'refs/remotes/g/x'"],
            reftable: [
              'NOT_A_DIRECTORY',
              'g',
              "cannot process 'refs/remotes/g/x' and 'refs/remotes/g'",
            ],
          },
        },
        {
          label: 'deleting the absent j before creating j/x',
          slug: 'absent-delete-create-under',
          existing: [],
          updates: [
            ['delete', 'j'],
            ['create', 'j/x'],
          ],
          refusal: same(
            'FILE_EXISTS',
            'j/x',
            "cannot process 'refs/remotes/j' and 'refs/remotes/j/x'",
          ),
        },
        {
          label: 'creating q and q/x before e/x/y under the existing e',
          slug: 'lock-phase-first',
          existing: ['e'],
          updates: [
            ['create', 'q'],
            ['create', 'q/x'],
            ['create', 'e/x/y'],
          ],
          refusal: {
            files: [
              'NOT_A_DIRECTORY',
              'e',
              "'refs/remotes/e' exists; cannot create 'refs/remotes/e/x/y'",
            ],
            reftable: [
              'FILE_EXISTS',
              'q/x',
              "cannot process 'refs/remotes/q' and 'refs/remotes/q/x'",
            ],
          },
        },
      ];
      const BACKENDS = [
        { backend: 'files', pairOf: filesCasePair, commit: () => filesC1 },
        {
          backend: 'reftable',
          pairOf: reftableCasePair,
          commit: () => git(reftableBase, 'rev-parse', 'main').trim(),
        },
      ] as const;
      const stdinOf = (updates: readonly StdinUpdate[], id: string): string =>
        updates
          .map(([verb, short]) =>
            verb === 'create' ? `create ${remote(short)} ${id}\n` : `delete ${remote(short)}\n`,
          )
          .join('');
      const refUpdatesOf = (updates: readonly StdinUpdate[], id: string): readonly RefUpdate[] =>
        updates.map(([verb, short]) =>
          verb === 'create'
            ? { kind: 'set', name: remote(short), id: id as ObjectId }
            : { kind: 'delete', name: remote(short) },
        );
      const listRemotes = (dir: string): string =>
        git(dir, 'for-each-ref', '--format=%(refname)', 'refs/remotes/');

      interface PriorityRow {
        readonly label: string;
        readonly slug: string;
        /** `update <ref> <id> <mismatched old>` lines are spelled by index. */
        readonly updates: readonly StdinUpdate[];
        /** Where the mismatching update sits among `updates`. */
        readonly mismatchAt: number;
        readonly refusal: Readonly<
          Record<'files' | 'reftable', { readonly code: string; readonly blocking?: string }>
        >;
      }

      const CONFLICT: Record<
        'files' | 'reftable',
        { readonly code: string; readonly blocking?: string }
      > = {
        files: { code: 'NOT_A_DIRECTORY', blocking: 'v' },
        reftable: { code: 'REF_UPDATE_CONFLICT' },
      };
      const MISMATCH = {
        files: { code: 'REF_UPDATE_CONFLICT' },
        reftable: { code: 'REF_UPDATE_CONFLICT' },
      } as const;

      const PRIORITY_ROWS: readonly PriorityRow[] = [
        {
          label: 'a pair checked under their locks before the value mismatch',
          slug: 'lock-before-mismatch',
          updates: [
            ['create', 'v/w'],
            ['create', 'v/w/y'],
          ],
          mismatchAt: 2,
          refusal: CONFLICT,
        },
        {
          label: 'the value mismatch before a pair checked under their locks',
          slug: 'mismatch-before-lock',
          updates: [
            ['create', 'v/w'],
            ['create', 'v/w/y'],
          ],
          mismatchAt: 0,
          refusal: MISMATCH,
        },
        {
          label: 'a pair checked only in the batch before the value mismatch',
          slug: 'batch-before-mismatch',
          updates: [
            ['create', 'f'],
            ['create', 'f/x'],
          ],
          mismatchAt: 2,
          refusal: MISMATCH,
        },
      ];

      describe.each(BACKENDS)(
        'When git update-ref --stdin and applyRefUpdates run both refusals on $backend',
        ({ backend, pairOf, commit }) => {
          it.each(PRIORITY_ROWS)(
            'Then both report $label the same way',
            async ({ slug, updates, mismatchAt, refusal }) => {
              // Arrange — `v` exists, so a create under it is refused while
              // its lock is taken; `main` is moved with a value it does not
              // hold, so its own update refuses too.
              const { peer, ours, ctx } = await pairOf(`${backend}-${slug}`);
              const id = commit();
              for (const dir of [peer, ours]) runGit(['-C', dir, 'update-ref', remote('v'), id]);
              const mismatch = `update ${remote('v')} ${id} ${ZERO}\n`;
              const lines = [
                ...stdinOf(updates, id)
                  .split(/(?<=\n)/)
                  .filter((l) => l.length > 0),
              ];
              lines.splice(mismatchAt, 0, mismatch);
              const mismatchUpdate: RefUpdate = {
                kind: 'set',
                name: remote('v'),
                id: id as ObjectId,
                expected: 'absent',
              };
              const refUpdates = [...refUpdatesOf(updates, id)];
              refUpdates.splice(mismatchAt, 0, mismatchUpdate);
              const refsBefore = listRemotes(peer);
              const sut = getRefStore(ctx);

              // Act
              const gitResult = tryRunGitWithExit(['-C', peer, 'update-ref', '--stdin'], {
                input: lines.join(''),
                env: runGitEnv(),
              });
              let caught: unknown;
              try {
                await sut.applyRefUpdates(refUpdates);
              } catch (err) {
                caught = err;
              }

              // Assert
              const expected = refusal[backend];
              expect(gitResult.exitCode).toBe(128);
              expect(gitResult.stderr).toContain(
                expected.blocking === undefined
                  ? `cannot lock ref '${remote('v')}': reference already exists`
                  : `'${remote(expected.blocking)}' exists; cannot create`,
              );
              expect((caught as TsgitError).data).toEqual(
                expected.blocking === undefined
                  ? { code: expected.code, name: remote('v'), expected: 'absent', actual: id }
                  : {
                      code: expected.code,
                      path: `${ctx.layout.gitDir}/${remote(expected.blocking)}`,
                    },
              );
              expect(listRemotes(peer)).toBe(refsBefore);
              expect(listRemotes(ours)).toBe(refsBefore);
            },
          );
        },
      );

      interface SingleRow {
        readonly label: string;
        readonly slug: string;
        /** Created, then packed on the files backend so no loose file backs it. */
        readonly existing: string;
        readonly update: StdinUpdate;
        readonly exitCode: number;
        readonly code: string;
        readonly blocking: string;
        readonly message: string;
      }

      const SINGLE_ROWS: readonly SingleRow[] = [
        {
          label: 'creating k/z under the existing k',
          slug: 'single-create-under',
          existing: 'k',
          update: ['create', 'k/z'],
          exitCode: 128,
          code: 'NOT_A_DIRECTORY',
          blocking: 'k',
          message: "'refs/remotes/k' exists; cannot create 'refs/remotes/k/z'",
        },
        {
          label: 'deleting the absent e above the existing e/x',
          slug: 'single-delete-above',
          existing: 'e/x',
          update: ['delete', 'e'],
          exitCode: 1,
          code: 'FILE_EXISTS',
          blocking: 'e/x',
          message: "'refs/remotes/e/x' exists; cannot create 'refs/remotes/e'",
        },
        {
          label: 'deleting the absent d/x/y under the existing d/x',
          slug: 'single-delete-under',
          existing: 'd/x',
          update: ['delete', 'd/x/y'],
          exitCode: 1,
          code: 'NOT_A_DIRECTORY',
          blocking: 'd/x',
          message: "'refs/remotes/d/x' exists; cannot create 'refs/remotes/d/x/y'",
        },
      ];

      describe.each(BACKENDS)(
        'When git update-ref and applyRefUpdates run ONE such update on $backend',
        ({ backend, pairOf, commit }) => {
          it.each(SINGLE_ROWS)(
            'Then both refuse $label and change nothing',
            async ({ slug, existing, update, exitCode, code, blocking, message }) => {
              // Arrange — packed on the files backend, so no loose file or
              // directory can answer the availability question.
              const { peer, ours, ctx } = await pairOf(`${backend}-${slug}`);
              const id = commit();
              for (const dir of [peer, ours]) {
                runGit(['-C', dir, 'update-ref', remote(existing), id]);
                if (backend === 'files') git(dir, 'pack-refs', '--all');
              }
              const refsBefore = listRemotes(peer);
              const sut = getRefStore(ctx);

              // Act
              const [verb, short] = update;
              const gitResult = tryRunGitWithExit(
                verb === 'create'
                  ? ['-C', peer, 'update-ref', remote(short), id]
                  : ['-C', peer, 'update-ref', '-d', remote(short)],
                { env: runGitEnv() },
              );
              let caught: unknown;
              try {
                await sut.applyRefUpdates(refUpdatesOf([update], id));
              } catch (err) {
                caught = err;
              }

              // Assert
              expect(gitResult.exitCode).toBe(exitCode);
              expect(gitResult.stderr).toContain(message);
              expect((caught as TsgitError).data).toEqual({
                code,
                path: `${ctx.layout.gitDir}/${remote(blocking)}`,
              });
              expect(listRemotes(peer)).toBe(refsBefore);
              expect(listRemotes(ours)).toBe(refsBefore);
            },
          );
        },
      );

      describe.each(BACKENDS)(
        'When git update-ref --stdin and applyRefUpdates run it on $backend',
        ({ backend, pairOf, commit }) => {
          it.each(ROWS)(
            'Then both refuse $label and change nothing',
            async ({ slug, existing, updates, refusal }) => {
              // Arrange
              const { peer, ours, ctx } = await pairOf(`names-${backend}-${slug}`);
              const id = commit();
              for (const dir of [peer, ours]) {
                for (const short of existing) runGit(['-C', dir, 'update-ref', remote(short), id]);
              }
              const refsBefore = listRemotes(peer);
              const sut = getRefStore(ctx);

              // Act
              const gitResult = tryRunGitWithExit(['-C', peer, 'update-ref', '--stdin'], {
                input: stdinOf(updates, id),
                env: runGitEnv(),
              });
              let caught: unknown;
              try {
                await sut.applyRefUpdates(refUpdatesOf(updates, id));
              } catch (err) {
                caught = err;
              }

              // Assert
              const [code, blocking, message] = refusal[backend];
              expect(gitResult.exitCode).toBe(128);
              expect(gitResult.stderr).toContain(message);
              expect((caught as TsgitError).data).toEqual({
                code,
                path: `${ctx.layout.gitDir}/${remote(blocking)}`,
              });
              expect(listRemotes(peer)).toBe(refsBefore);
              expect(listRemotes(ours)).toBe(refsBefore);
            },
          );
        },
      );
    });
  },
);
