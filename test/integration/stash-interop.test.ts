/**
 * Cross-tool interop — `stash` porcelain. Drives `repo.stash.{push,apply}`
 * through the `openRepository` facade and the same flow via canonical
 * `git stash` on a peer repo seeded identically, then asserts the results
 * agree. The W/I/U *commits* embed a committer timestamp (so their OIDs are not
 * comparable), but the stashed *trees* are content-addressed — equal tree OIDs
 * across the two repos prove the stash captured byte-identical state. Real
 * `git` reads tsgit's `refs/stash`, which also proves the on-disk stack is
 * git-faithful.
 *
 * @proves
 *   surface:        stash
 *   bucket:         cross-tool-interop
 *   unique:         stash push/apply index+tree state matches canonical git stash
 *   interopSurface: stash
 */
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EolNotice } from '../../src/domain/eol/crlf-conversion.js';
import type { TsgitError } from '../../src/domain/error.js';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import {
  type EolRepoOptions,
  enc,
  looseObjectIds,
  reconstructSafecrlfLine,
  setEolConfig,
} from './eol-interop-fixtures.js';
import {
  GIT_AVAILABLE,
  git,
  lsStage,
  makePeerPair,
  type PeerPair,
  runGit,
  runGitBytes,
  tryRunGit,
  tryRunGitWithExit,
} from './interop-helpers.js';

const AUTHOR = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
} as const;

const writeBoth = async (pair: PeerPair, rel: string, content: string): Promise<void> => {
  const parent = path.dirname(rel);
  for (const dir of [pair.peer, pair.ours]) {
    if (parent !== '.') await mkdir(path.join(dir, parent), { recursive: true });
    await writeFile(path.join(dir, rel), content);
  }
};

const readBoth = async (pair: PeerPair, rel: string): Promise<{ peer: string; ours: string }> => ({
  peer: await readFile(path.join(pair.peer, rel), 'utf8'),
  ours: await readFile(path.join(pair.ours, rel), 'utf8'),
});

describe.skipIf(!GIT_AVAILABLE)('stash porcelain interop', () => {
  let pair: PeerPair;
  let repo: Repository;

  beforeEach(async () => {
    pair = await makePeerPair('stash');
    runGit(['init', '-q', '-b', 'main', pair.peer]);
    git(pair.peer, 'config', 'user.name', 'Ada');
    git(pair.peer, 'config', 'user.email', 'ada@example.com');
    repo = await openRepository({ cwd: pair.ours });
    await repo.init();
  });

  afterEach(async () => {
    await repo.dispose();
    await pair.dispose();
  });

  const seed = async (): Promise<void> => {
    await writeBoth(pair, 'a.txt', 'line1\n');
    git(pair.peer, 'add', 'a.txt');
    git(pair.peer, 'commit', '-q', '-m', 'seed');
    await repo.add(['a.txt']);
    await repo.commit({ message: 'seed', author: AUTHOR });
  };

  describe('Given an identical unstaged change in both repos', () => {
    describe('When stash push runs in each', () => {
      it('Then the stashed trees match and both working trees reset to HEAD', async () => {
        // Arrange
        await seed();
        await writeBoth(pair, 'a.txt', 'line1\nline2\n');

        // Act
        git(pair.peer, 'stash');
        const saved = await repo.stash.push();

        // Assert — stash saved on both
        expect(saved.kind).toBe('saved');
        // Working trees reset to the committed content.
        const after = await readBoth(pair, 'a.txt');
        expect(after.ours).toBe('line1\n');
        expect(after.peer).toBe('line1\n');
        // The stashed working-tree (W) and index (I) trees are byte-identical.
        expect(git(pair.ours, 'rev-parse', 'stash@{0}^{tree}')).toBe(
          git(pair.peer, 'rev-parse', 'stash@{0}^{tree}'),
        );
        expect(git(pair.ours, 'rev-parse', 'stash@{0}^2^{tree}')).toBe(
          git(pair.peer, 'rev-parse', 'stash@{0}^2^{tree}'),
        );
        // The post-push index reads back identically.
        expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
        // One stack entry on each side.
        expect(git(pair.ours, 'stash', 'list').trim().split('\n')).toHaveLength(1);
      });
    });
  });

  describe('Given a stash applied back onto a clean tree', () => {
    describe('When stash apply runs in each', () => {
      it('Then the change is restored identically', async () => {
        // Arrange
        await seed();
        await writeBoth(pair, 'a.txt', 'line1\nline2\n');
        git(pair.peer, 'stash');
        await repo.stash.push();

        // Act
        git(pair.peer, 'stash', 'apply');
        const applied = await repo.stash.apply();

        // Assert
        expect(applied.kind).toBe('applied');
        const after = await readBoth(pair, 'a.txt');
        expect(after.ours).toBe('line1\nline2\n');
        expect(after.peer).toBe('line1\nline2\n');
      });
    });
  });

  describe('Given an unborn branch with a staged change', () => {
    describe('When stash push runs in each', () => {
      it('Then both refuse', async () => {
        // Arrange
        await writeBoth(pair, 'a.txt', 'x\n');
        git(pair.peer, 'add', 'a.txt');
        await repo.add(['a.txt']);

        // Act — canonical git refuses on the unborn branch.
        const peerResult = tryRunGit(['-C', pair.peer, 'stash']);

        // Assert
        expect(peerResult.ok).toBe(false);
        let oursCode: string | undefined;
        await repo.stash.push().catch((err: TsgitError) => {
          oursCode = err.data.code;
        });
        expect(oursCode).toBe('NO_INITIAL_COMMIT');
      });
    });
  });

  describe('Given a dirty working file on the stashed path', () => {
    describe('When stash apply runs in each', () => {
      it('Then both refuse to overwrite the local change', async () => {
        // Arrange
        await seed();
        await writeBoth(pair, 'a.txt', 'line1\nstashed\n');
        git(pair.peer, 'stash');
        await repo.stash.push();
        await writeBoth(pair, 'a.txt', 'line1\nlocal edit\n');

        // Act — canonical git refuses ("local changes would be overwritten").
        const peerResult = tryRunGit(['-C', pair.peer, 'stash', 'apply']);

        // Assert
        expect(peerResult.ok).toBe(false);
        let oursCode: string | undefined;
        await repo.stash.apply().catch((err: TsgitError) => {
          oursCode = err.data.code;
        });
        expect(oursCode).toBe('STASH_APPLY_WOULD_OVERWRITE');
      });
    });
  });

  describe('Given an untracked DANGLING symlink squats a stashed untracked path', () => {
    describe('When stash pop runs in each', () => {
      it('Then both refuse to overwrite it, and the stash is kept — matching git exactly', async () => {
        // Arrange
        await seed();
        await writeFile(path.join(pair.peer, 'u.txt'), 'untracked\n');
        await writeFile(path.join(pair.ours, 'u.txt'), 'untracked\n');
        git(pair.peer, 'stash', 'push', '-u', '-m', 'untracked test');
        await repo.stash.push({ includeUntracked: true });
        await symlink('/nonexistent/dangling-stash-target', path.join(pair.peer, 'u.txt'));
        await symlink('/nonexistent/dangling-stash-target', path.join(pair.ours, 'u.txt'));

        // Act — canonical git refuses ("<path> already exists, no checkout").
        const peerResult = tryRunGit(['-C', pair.peer, 'stash', 'pop']);

        // Assert
        expect(peerResult.ok).toBe(false);
        expect(peerResult.stderr).toContain('already exists');
        let oursCode: string | undefined;
        await repo.stash.pop().catch((err: TsgitError) => {
          oursCode = err.data.code;
        });
        expect(oursCode).toBe('STASH_APPLY_WOULD_OVERWRITE');
        // The stash is kept on both — a failed pop never drops its entry.
        expect(tryRunGit(['-C', pair.peer, 'stash', 'list']).stdout).not.toBe('');
        expect((await repo.stash.list()).entries).toHaveLength(1);
      });
    });
  });

  describe('line-ending conversion', () => {
    const LF_SEED = 'a\nb\nc\n';

    const seedLf = async (config: EolRepoOptions): Promise<void> => {
      await writeBoth(pair, 'a.txt', LF_SEED);
      git(pair.peer, 'add', 'a.txt');
      git(pair.peer, 'commit', '-q', '-m', 'seed');
      await repo.add(['a.txt']);
      await repo.commit({ message: 'seed', author: AUTHOR });
      setEolConfig(pair.peer, config);
      setEolConfig(pair.ours, config);
    };

    const stashedBlob = (dir: string, spec: string): string =>
      enc(runGitBytes(['-C', dir, 'cat-file', 'blob', spec]));

    const looseBlobIds = (dir: string): ReadonlyArray<string> =>
      looseObjectIds(dir).filter((id) => git(dir, 'cat-file', '-t', id).trim() === 'blob');

    /** Commit ids embed timestamps, so a commit is compared by its tree and parent count. */
    const looseShape = (dir: string): ReadonlyArray<string> =>
      looseObjectIds(dir)
        .map((id) => {
          const type = git(dir, 'cat-file', '-t', id).trim();
          if (type !== 'commit') return `${type} ${id}`;
          const headers = git(dir, 'cat-file', '-p', id).split('\n');
          const tree = headers.find((line) => line.startsWith('tree '));
          const parents = headers.filter((line) => line.startsWith('parent ')).length;
          return `commit ${tree} parents=${parents}`;
        })
        .sort();

    describe('Given core.autocrlf true and a CRLF worktree of an LF-tracked file', () => {
      describe('When stash push runs in each', () => {
        it('Then the stashed blob is LF and the W trees match', async () => {
          // Arrange
          await seedLf({ autoCrlf: 'true' });
          await writeBoth(pair, 'a.txt', 'a\r\nb\r\nc\r\nd\r\n');

          // Act
          git(pair.peer, 'stash');
          await repo.stash.push();

          // Assert
          expect(stashedBlob(pair.ours, 'stash@{0}:a.txt')).toBe('aNbNcNdN');
          expect(stashedBlob(pair.peer, 'stash@{0}:a.txt')).toBe('aNbNcNdN');
          expect(git(pair.ours, 'rev-parse', 'stash@{0}^{tree}')).toBe(
            git(pair.peer, 'rev-parse', 'stash@{0}^{tree}'),
          );
        });
      });
    });

    describe('Given core.autocrlf true and core.safecrlf true with an LF edit', () => {
      describe('When stash push runs in each', () => {
        it('Then both refuse, leave the same loose blobs, no stash ref and an untouched worktree', async () => {
          // Arrange
          await seedLf({ autoCrlf: 'true', safeCrlf: 'true' });
          await writeBoth(pair, 'a.txt', 'a\nb\nc\nd\n');

          // Act
          const peerResult = tryRunGitWithExit(['-C', pair.peer, 'stash']);
          const error = await repo.stash.push().then(
            () => undefined,
            (e: unknown) => e as TsgitError,
          );

          // Assert
          expect(peerResult.exitCode).toBe(1);
          expect(error?.data).toEqual({
            code: 'EOL_ROUND_TRIP_UNSAFE',
            path: 'a.txt',
            loss: 'lf-to-crlf',
            crlf: 0,
            loneLf: 4,
          });
          expect(peerResult.stderr).toContain(
            reconstructSafecrlfLine({ path: 'a.txt', loss: 'lf-to-crlf' }, 'fatal'),
          );
          expect(looseBlobIds(pair.ours)).toEqual(looseBlobIds(pair.peer));
          for (const dir of [pair.peer, pair.ours]) {
            expect(tryRunGit(['-C', dir, 'rev-parse', '--verify', '-q', 'refs/stash']).ok).toBe(
              false,
            );
            expect(await readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('a\nb\nc\nd\n');
          }
        });
      });
    });

    describe.each([
      {
        title: 'a lossy tracked edit',
        pushArgs: ['stash'],
        input: {},
        files: { 'a.txt': 'a\nb\nc\nd\n' },
      },
      {
        title: 'a lossy tracked edit and an untracked file under -u',
        pushArgs: ['stash', 'push', '-u'],
        input: { includeUntracked: true },
        files: { 'a.txt': 'a\nb\nc\nd\n', 'u.txt': 'u\r\n' },
      },
      {
        title: 'a lossy untracked file with a clean tracked tree under -u',
        pushArgs: ['stash', 'push', '-u'],
        input: { includeUntracked: true },
        files: { 'u.txt': 'u\n' },
      },
    ])('Given core.safecrlf true and $title', ({ pushArgs, input, files }) => {
      describe('When stash push refuses in each', () => {
        it('Then both leave the same loose objects by type, tree and parent count', async () => {
          // Arrange
          await seedLf({ autoCrlf: 'true', safeCrlf: 'true' });
          for (const [name, content] of Object.entries(files)) {
            await writeBoth(pair, name, content);
          }
          const peerBefore = looseShape(pair.peer);
          const oursBefore = looseShape(pair.ours);

          // Act
          const peerResult = tryRunGitWithExit(['-C', pair.peer, ...pushArgs]);
          const error = await repo.stash.push(input).then(
            () => undefined,
            (e: unknown) => e as TsgitError,
          );

          // Assert
          expect(peerResult.exitCode).toBe(1);
          expect(error?.data.code).toBe('EOL_ROUND_TRIP_UNSAFE');
          const peerWritten = looseShape(pair.peer).filter((o) => !peerBefore.includes(o));
          const oursWritten = looseShape(pair.ours).filter((o) => !oursBefore.includes(o));
          expect(peerWritten.some((o) => o.startsWith('commit '))).toBe(true);
          expect(oursWritten).toEqual(peerWritten);
        });
      });
    });

    describe('Given [filter "u"] required = foo and only an untracked file to hash', () => {
      describe('When stash push -u runs in each', () => {
        it('Then both refuse the malformed boolean after writing the same index commit', async () => {
          // Arrange
          git(pair.peer, 'commit', '-q', '--allow-empty', '-m', 'seed');
          await repo.commit({ message: 'seed', author: AUTHOR, allowEmpty: true });
          for (const dir of [pair.peer, pair.ours]) git(dir, 'config', 'filter.u.required', 'foo');
          await writeBoth(pair, 'n.txt', 'n\n');
          const peerBefore = looseShape(pair.peer);
          const oursBefore = looseShape(pair.ours);

          // Act
          const peerResult = tryRunGitWithExit(['-C', pair.peer, 'stash', 'push', '-u']);
          const error = await repo.stash.push({ includeUntracked: true }).then(
            () => undefined,
            (e: unknown) => e as TsgitError,
          );

          // Assert
          expect(peerResult.exitCode).toBe(1);
          expect(peerResult.stderr).toContain(
            "bad boolean config value 'foo' for 'filter.u.required'",
          );
          expect(error?.data).toMatchObject({
            code: 'CONFIG_BAD_BOOLEAN_VALUE',
            key: 'filter.u.required',
            value: 'foo',
          });
          const peerWritten = looseShape(pair.peer).filter((o) => !peerBefore.includes(o));
          const oursWritten = looseShape(pair.ours).filter((o) => !oursBefore.includes(o));
          expect(peerWritten).toEqual([
            'commit tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904 parents=1',
          ]);
          expect(oursWritten).toEqual(peerWritten);
        });
      });
    });

    describe('Given core.autocrlf true and the default core.safecrlf with an LF edit', () => {
      describe('When stash push runs in each', () => {
        it('Then both save with the one warning and the W trees match', async () => {
          // Arrange
          await seedLf({ autoCrlf: 'true' });
          await writeBoth(pair, 'a.txt', 'a\nb\nc\nd\n');

          // Act
          const peerResult = tryRunGitWithExit(['-C', pair.peer, 'stash']);
          const saved = await repo.stash.push();

          // Assert
          expect(peerResult.exitCode).toBe(0);
          if (saved.kind !== 'saved') throw new Error('expected saved');
          expect(saved.eolNotices).toHaveLength(1);
          const notice = saved.eolNotices[0] as EolNotice;
          expect(peerResult.stderr).toContain(reconstructSafecrlfLine(notice, 'warning'));
          expect(git(pair.ours, 'rev-parse', 'stash@{0}^{tree}')).toBe(
            git(pair.peer, 'rev-parse', 'stash@{0}^{tree}'),
          );
        });
      });
    });

    describe('Given core.autocrlf true, an untracked file and a tracked LF edit', () => {
      describe('When stash push -u runs in each', () => {
        it('Then the untracked blob, the U tree and the warning order match', async () => {
          // Arrange
          await seedLf({ autoCrlf: 'true' });
          await writeBoth(pair, 'a.txt', 'a\nb\nc\nd\n');
          await writeBoth(pair, 'zz.txt', 'u\n');
          await writeBoth(pair, 'crlf.txt', 'u1\r\nu2\r\n');

          // Act
          const peerResult = tryRunGitWithExit(['-C', pair.peer, 'stash', 'push', '-u']);
          const saved = await repo.stash.push({ includeUntracked: true });

          // Assert
          if (saved.kind !== 'saved') throw new Error('expected saved');
          const oursOrder = saved.eolNotices.map((n) => reconstructSafecrlfLine(n, 'warning'));
          const peerOrder = peerResult.stderr
            .split('\n')
            .filter((line) => line.startsWith('warning: in the working copy'));
          expect(oursOrder).toEqual(peerOrder);
          expect(stashedBlob(pair.ours, 'stash@{0}^3:crlf.txt')).toBe('u1Nu2N');
          expect(git(pair.ours, 'rev-parse', 'stash@{0}^3^{tree}')).toBe(
            git(pair.peer, 'rev-parse', 'stash@{0}^3^{tree}'),
          );
        });
      });
    });
  });
});
