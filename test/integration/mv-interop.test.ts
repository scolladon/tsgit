/**
 * Cross-tool interop — `mv` porcelain. Drives `repo.mv` through the
 * `openRepository` facade and the same move via canonical `git mv` on a peer
 * repo seeded identically, then asserts the resulting index (`git ls-files
 * --stage`), tree (`git write-tree`), and working tree agree. This is the
 * faithfulness proof that the mv *orchestration* matches git — which the
 * cross-adapter parity golden (tsgit-computed) cannot vouch for.
 *
 * @proves
 *   surface:        mv
 *   bucket:         cross-tool-interop
 *   unique:         mv porcelain index+tree state matches canonical git mv
 *   interopSurface: mv
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TsgitError } from '../../src/domain/error.js';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import {
  GIT_AVAILABLE,
  lsStage,
  makePeerPair,
  mvVerboseLines,
  type PeerPair,
  runGit,
  tryRunGit,
  tryRunGitWithExit,
  writeTreeOf,
} from './interop-helpers.js';

interface SeedFile {
  readonly path: string;
  readonly content: string;
}

interface StateSnapshot {
  readonly stage: string;
  readonly tree: string;
}

const pathExists = async (dir: string, rel: string): Promise<boolean> => {
  try {
    await stat(path.join(dir, rel));
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(!GIT_AVAILABLE)('mv porcelain interop', () => {
  let pair: PeerPair;
  let repo: Repository;

  beforeEach(async () => {
    pair = await makePeerPair('mv');
    runGit(['init', '-q', '-b', 'main', pair.peer]);
    repo = await openRepository({ cwd: pair.ours });
    await repo.init();
  });

  afterEach(async () => {
    await repo.dispose();
    await pair.dispose();
  });

  const writeBoth = async (file: SeedFile): Promise<void> => {
    const parent = path.dirname(file.path);
    if (parent !== '.') {
      await mkdir(path.join(pair.peer, parent), { recursive: true });
      await mkdir(path.join(pair.ours, parent), { recursive: true });
    }
    await writeFile(path.join(pair.peer, file.path), file.content);
    await writeFile(path.join(pair.ours, file.path), file.content);
  };

  const seed = async (files: ReadonlyArray<SeedFile>): Promise<void> => {
    for (const file of files) await writeBoth(file);
    const paths = files.map((file) => file.path);
    runGit(['-C', pair.peer, 'add', ...paths]);
    await repo.add(paths);
  };

  const snapshot = (dir: string): StateSnapshot => ({
    stage: lsStage(dir),
    tree: writeTreeOf(dir),
  });

  describe('Given a tracked file staged in both repos', () => {
    describe('When repo.mv renames it and git mv renames the peer', () => {
      it('Then the index, tree, and working tree match canonical git', async () => {
        // Arrange
        await seed([{ path: 'a.txt', content: 'hello\n' }]);

        // Act
        const moved = await repo.mv(['a.txt'], 'renamed.txt');
        runGit(['-C', pair.peer, 'mv', 'a.txt', 'renamed.txt']);
        const result = snapshot(pair.ours);

        // Assert
        const peer = snapshot(pair.peer);
        expect(result.stage).toBe(peer.stage);
        expect(result.tree).toBe(peer.tree);
        expect(moved.moved).toEqual([{ from: 'a.txt', to: 'renamed.txt' }]);
        await expect(readFile(path.join(pair.ours, 'renamed.txt'), 'utf8')).resolves.toBe(
          'hello\n',
        );
        await expect(pathExists(pair.ours, 'a.txt')).resolves.toBe(false);
      });
    });
  });

  describe('Given a tracked file and an existing tracked directory', () => {
    describe('When repo.mv moves the file into the directory like git mv', () => {
      it('Then the file reparents to dir/<basename> identically to git', async () => {
        // Arrange
        await seed([
          { path: 'b.txt', content: 'bee\n' },
          { path: 'dir/keep.txt', content: 'keep\n' },
        ]);

        // Act
        const moved = await repo.mv(['b.txt'], 'dir');
        runGit(['-C', pair.peer, 'mv', 'b.txt', 'dir']);
        const result = snapshot(pair.ours);

        // Assert
        const peer = snapshot(pair.peer);
        expect(result.stage).toBe(peer.stage);
        expect(result.tree).toBe(peer.tree);
        expect(moved.moved).toEqual([{ from: 'b.txt', to: 'dir/b.txt' }]);
        await expect(pathExists(pair.ours, 'dir/b.txt')).resolves.toBe(true);
      });
    });
  });

  describe('Given a tracked subtree staged in both repos', () => {
    describe('When repo.mv renames the directory like git mv', () => {
      it('Then every entry reparents identically to git', async () => {
        // Arrange
        await seed([
          { path: 'old/one.txt', content: '1\n' },
          { path: 'old/nested/two.txt', content: '2\n' },
        ]);

        // Act
        await repo.mv(['old'], 'new');
        runGit(['-C', pair.peer, 'mv', 'old', 'new']);
        const result = snapshot(pair.ours);

        // Assert
        const peer = snapshot(pair.peer);
        expect(result.stage).toBe(peer.stage);
        expect(result.tree).toBe(peer.tree);
        await expect(pathExists(pair.ours, 'new/nested/two.txt')).resolves.toBe(true);
        await expect(pathExists(pair.ours, 'old')).resolves.toBe(false);
      });
    });
  });

  describe('Given two tracked files', () => {
    describe('When repo.mv -f overwrites one with the other like git mv -f', () => {
      it('Then the destination carries the source blob identically to git', async () => {
        // Arrange
        await seed([
          { path: 'a.txt', content: 'source\n' },
          { path: 'b.txt', content: 'target\n' },
        ]);

        // Act
        await repo.mv(['a.txt'], 'b.txt', { force: true });
        runGit(['-C', pair.peer, 'mv', '-f', 'a.txt', 'b.txt']);
        const result = snapshot(pair.ours);

        // Assert
        const peer = snapshot(pair.peer);
        expect(result.stage).toBe(peer.stage);
        expect(result.tree).toBe(peer.tree);
        await expect(readFile(path.join(pair.ours, 'b.txt'), 'utf8')).resolves.toBe('source\n');
        await expect(pathExists(pair.ours, 'a.txt')).resolves.toBe(false);
      });
    });
  });

  describe('Given a staged file whose working copy was edited but not re-staged', () => {
    describe('When repo.mv renames it like git mv', () => {
      it('Then the staged blob travels unchanged and the edit rides the working file', async () => {
        // Arrange
        await seed([{ path: 'a.txt', content: 'staged\n' }]);
        await writeFile(path.join(pair.peer, 'a.txt'), 'edited\n');
        await writeFile(path.join(pair.ours, 'a.txt'), 'edited\n');

        // Act
        await repo.mv(['a.txt'], 'renamed.txt');
        runGit(['-C', pair.peer, 'mv', 'a.txt', 'renamed.txt']);
        const result = snapshot(pair.ours);

        // Assert
        const peer = snapshot(pair.peer);
        expect(result.stage).toBe(peer.stage);
        expect(result.tree).toBe(peer.tree);
        await expect(readFile(path.join(pair.ours, 'renamed.txt'), 'utf8')).resolves.toBe(
          'edited\n',
        );
      });
    });
  });

  describe('Given an untracked source path', () => {
    describe('When repo.mv is asked to move it', () => {
      it('Then it refuses like git mv and mutates nothing', async () => {
        // Arrange
        await seed([{ path: 'a.txt', content: 'hello\n' }]);
        const before = lsStage(pair.ours);

        // Act
        const peerRun = tryRunGit(['-C', pair.peer, 'mv', 'ghost.txt', 'dest.txt']);
        let code = '';
        try {
          await repo.mv(['ghost.txt'], 'dest.txt');
        } catch (error) {
          code = (error as TsgitError).data.code;
        }

        // Assert
        expect(peerRun.ok).toBe(false);
        expect(code).toBe('MV_SOURCE_NOT_TRACKED');
        expect(lsStage(pair.ours)).toBe(before);
      });
    });
  });

  describe('Given a destination that is already tracked', () => {
    describe('When repo.mv moves onto it without force', () => {
      it('Then it refuses like git mv and mutates nothing', async () => {
        // Arrange
        await seed([
          { path: 'a.txt', content: 'source\n' },
          { path: 'b.txt', content: 'target\n' },
        ]);
        const before = lsStage(pair.ours);

        // Act
        const peerRun = tryRunGit(['-C', pair.peer, 'mv', 'a.txt', 'b.txt']);
        let code = '';
        try {
          await repo.mv(['a.txt'], 'b.txt');
        } catch (error) {
          code = (error as TsgitError).data.code;
        }

        // Assert
        expect(peerRun.ok).toBe(false);
        expect(code).toBe('MV_DESTINATION_EXISTS');
        expect(lsStage(pair.ours)).toBe(before);
      });
    });
  });

  describe('Given a directory and a path inside it as overlapping sources', () => {
    describe('When repo.mv is asked to move both', () => {
      it('Then it refuses like git mv and mutates nothing', async () => {
        // Arrange
        await seed([
          { path: 'sub/x.txt', content: 'x\n' },
          { path: 'target/keep.txt', content: 'keep\n' },
        ]);
        const before = lsStage(pair.ours);

        // Act
        const peerRun = tryRunGit(['-C', pair.peer, 'mv', 'sub', 'sub/x.txt', 'target']);
        let code = '';
        try {
          await repo.mv(['sub', 'sub/x.txt'], 'target');
        } catch (error) {
          code = (error as TsgitError).data.code;
        }

        // Assert
        expect(peerRun.ok).toBe(false);
        expect(code).toBe('MV_OVERLAPPING_SOURCES');
        expect(lsStage(pair.ours)).toBe(before);
      });
    });
  });

  describe('Given a directory holding an empty directory and an untracked file', () => {
    describe('When repo.mv renames it and git mv renames the peer (row E)', () => {
      it('Then both twins hold the empty directory, the tracked and the untracked file', async () => {
        // Arrange
        await seed([{ path: 'd/f', content: 'f\n' }]);
        await mkdir(path.join(pair.peer, 'd/emp'));
        await mkdir(path.join(pair.ours, 'd/emp'));
        await writeBoth({ path: 'd/u', content: 'u\n' });

        // Act
        runGit(['-C', pair.peer, 'mv', 'd', 'e']);
        await repo.mv(['d'], 'e');

        // Assert
        for (const dir of [pair.peer, pair.ours]) {
          expect(await pathExists(dir, 'e/emp')).toBe(true);
          expect(await pathExists(dir, 'e/f')).toBe(true);
          expect(await pathExists(dir, 'e/u')).toBe(true);
          expect(await pathExists(dir, 'd')).toBe(false);
        }
        expect(snapshot(pair.ours)).toEqual(snapshot(pair.peer));
      });
    });
  });
});

const Q200 = 'q'.repeat(200);
const L200 = 'l'.repeat(200);
const GIT_IDENTITY = [
  '-c',
  'user.name=t',
  '-c',
  'user.email=t@example.com',
  '-c',
  'commit.gpgsign=false',
];

describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')(
  'Given directories whose contents reach past PATH_MAX',
  () => {
    let root = '';
    let pathMax = 0;
    let counter = 0;
    const repos: Repository[] = [];

    beforeAll(async () => {
      root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-mv-deep-')));
      pathMax = Number(execFileSync('getconf', ['PATH_MAX', root]).toString().trim());
    });

    afterEach(async () => {
      await Promise.all(repos.splice(0).map((repo) => repo.dispose()));
    });

    afterAll(() => {
      execFileSync('rm', ['-rf', root]);
    });

    // process.chdir is refused in vitest workers and an absolute mkdir of the chain is
    // ENAMETOOLONG, so the shell walks the chain with relative steps.
    const inChain = (cwd: string, steps: ReadonlyArray<string>, command: string): void => {
      execFileSync(
        'sh',
        ['-c', 'for c in "$@"; do cd "$c" || exit 1; done; eval "$CMD"', 'sh', ...steps],
        {
          cwd,
          env: { ...process.env, CMD: command },
        },
      );
    };

    const buildChain = (cwd: string, steps: ReadonlyArray<string>): void => {
      execFileSync(
        'sh',
        ['-c', 'for c in "$@"; do mkdir "$c" && cd "$c" || exit 1; done; : > leaf', 'sh', ...steps],
        { cwd },
      );
    };

    const holdsLeaf = (cwd: string, steps: ReadonlyArray<string>): boolean => {
      try {
        inChain(cwd, steps, 'test -f leaf');
        return true;
      } catch {
        return false;
      }
    };

    const levelsPastPathMax = (): number => Math.floor(pathMax / (Q200.length + 1)) + 2;
    const chain = (): string[] => Array.from({ length: levelsPastPathMax() }, () => Q200);

    const newTwin = (side: string): string => {
      counter += 1;
      const repo = path.join(root, `${side}-${counter}`);
      runGit(['init', '-q', '-b', 'main', repo]);
      return repo;
    };

    const commitAll = (repo: string): void => {
      runGit(['-C', repo, 'add', '-A']);
      runGit(['-C', repo, ...GIT_IDENTITY, 'commit', '-q', '-m', 'm']);
    };

    const openTrackedRepository = async (cwd: string): Promise<Repository> => {
      const repo = await openRepository({ cwd });
      repos.push(repo);
      return repo;
    };

    const stageOf = (repo: string): string => runGit(['-C', repo, 'ls-files', '-s']);

    const seedTwin = async (side: string, tracked: ReadonlyArray<string>, deepUnder: string) => {
      const repo = newTwin(side);
      for (const file of tracked) {
        await mkdir(path.join(repo, path.dirname(file)), { recursive: true });
        await writeFile(path.join(repo, file), 'x\n');
      }
      runGit(['-C', repo, 'add', '--', ...tracked]);
      await mkdir(path.join(repo, deepUnder), { recursive: true });
      buildChain(path.join(repo, deepUnder), chain());
      return repo;
    };

    describe.each([
      { id: 'row 1', tracked: ['d/f'], deepUnder: 'd', kept: 'e/f', leafUnder: 'e' },
      { id: 'row 2', tracked: ['d/z'], deepUnder: 'd/a', kept: 'e/z', leafUnder: 'e/a' },
    ])('When git and tsgit rename a directory holding an untracked deep chain ($id)', (row) => {
      it('Then both rename it in one step and agree on the index and the disk', async () => {
        // Arrange
        const gitRepo = await seedTwin('git', row.tracked, row.deepUnder);
        const tsgitRepo = await seedTwin('tsgit', row.tracked, row.deepUnder);
        const leaf = path.join(tsgitRepo, row.deepUnder, ...chain(), 'leaf');
        expect(Buffer.byteLength(leaf)).toBeGreaterThan(pathMax);
        const sut = await openTrackedRepository(tsgitRepo);

        // Act
        runGit(['-C', gitRepo, 'mv', 'd', 'e']);
        await sut.mv(['d'], 'e');

        // Assert
        expect(stageOf(tsgitRepo)).toEqual(stageOf(gitRepo));
        for (const dir of [gitRepo, tsgitRepo]) {
          expect(await pathExists(dir, row.kept)).toBe(true);
          expect(await pathExists(dir, 'd')).toBe(false);
          expect(holdsLeaf(path.join(dir, row.leafUnder), chain())).toBe(true);
        }
      });
    });

    describe('When git and tsgit rename a directory holding a deep chain in a linked worktree (row 3)', () => {
      it('Then both rename it in one step and agree on the index and the disk', async () => {
        // Arrange
        const linked: string[] = [];
        for (const side of ['git', 'tsgit']) {
          const main = newTwin(side);
          await mkdir(path.join(main, 'd'));
          await writeFile(path.join(main, 'd/f'), 'x\n');
          commitAll(main);
          const wt = `${main}-wt`;
          runGit(['-C', main, 'worktree', 'add', '-q', '-b', `${side}-wt`, wt]);
          buildChain(path.join(wt, 'd'), chain());
          linked.push(wt);
        }
        const [gitWt, tsgitWt] = linked as [string, string];
        const sut = await openTrackedRepository(tsgitWt);

        // Act
        runGit(['-C', gitWt, 'mv', 'd', 'e']);
        await sut.mv(['d'], 'e');

        // Assert
        expect(stageOf(tsgitWt)).toEqual(stageOf(gitWt));
        for (const dir of [gitWt, tsgitWt]) {
          expect(await pathExists(dir, 'e/f')).toBe(true);
          expect(await pathExists(dir, 'd')).toBe(false);
          expect(holdsLeaf(path.join(dir, 'e'), chain())).toBe(true);
        }
      });
    });

    describe('When git and tsgit skip errors moving a long directory and a file under a deep destination (row H)', () => {
      it('Then both move the file, refuse the directory and agree on the index and the disk', async () => {
        // Arrange
        const destLength = pathMax - 150;
        const whole = Math.floor(destLength / (Q200.length + 1));
        const remainder = destLength - whole * (Q200.length + 1);
        const steps = [...Array.from({ length: whole }, () => Q200), 'r'.repeat(remainder - 1)];
        const dest = steps.join('/');
        const twinsOf: string[] = [];
        for (const side of ['git', 'tsgit']) {
          const repo = newTwin(side);
          for (const file of [`${L200}/f`, `${L200}/s/t`, 'b']) {
            await mkdir(path.join(repo, path.dirname(file)), { recursive: true });
            await writeFile(path.join(repo, file), 'x\n');
          }
          await writeFile(path.join(repo, `${L200}/u`), 'u\n');
          runGit(['-C', repo, 'add', '--', `${L200}/f`, `${L200}/s/t`, 'b']);
          execFileSync(
            'sh',
            ['-c', 'for c in "$@"; do mkdir "$c" && cd "$c" || exit 1; done', 'sh', ...steps],
            {
              cwd: repo,
            },
          );
          twinsOf.push(repo);
        }
        const [gitRepo, tsgitRepo] = twinsOf as [string, string];
        expect(Buffer.byteLength(`${dest}/${L200}`)).toBeGreaterThan(pathMax);
        expect(Buffer.byteLength(path.join(tsgitRepo, dest, 'b'))).toBeLessThan(pathMax);
        const sut = await openTrackedRepository(tsgitRepo);

        // Act
        const gitRun = tryRunGitWithExit(['-C', gitRepo, 'mv', '-k', '-v', '--', L200, 'b', dest]);
        const result = await sut.mv([L200, 'b'], dest, { skipErrors: true });

        // Assert
        expect(gitRun.exitCode).toBe(0);
        expect(result.skipped).toEqual([{ source: L200, reason: 'rename-failed' }]);
        expect(gitRun.stdout.split('\n').filter((line) => line !== '')).toEqual(
          mvVerboseLines([L200, 'b'], (source) => `${dest}/${source}`, result, [L200]),
        );
        expect(stageOf(tsgitRepo)).toEqual(stageOf(gitRepo));
        for (const dir of [gitRepo, tsgitRepo]) {
          expect(await pathExists(dir, L200)).toBe(false);
          expect(await pathExists(dir, 'b')).toBe(false);
          inChain(dir, steps, 'test -f b');
        }
      });
    });
  },
);

const isCaseInsensitiveHost = async (): Promise<boolean> => {
  const probeDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-mv-fold-probe-'));
  try {
    await writeFile(path.join(probeDir, 'Probe-File'), '');
    return existsSync(path.join(probeDir, 'probe-file'));
  } finally {
    await rm(probeDir, { recursive: true, force: true });
  }
};

const CASE_INSENSITIVE = await isCaseInsensitiveHost();

const ERRNO_TEXT: Readonly<Record<string, string>> = { EINVAL: 'Invalid argument' };

const diskEntries = async (dir: string): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(dir, { recursive: true });
  return entries.filter((entry) => entry !== '.git' && !entry.startsWith(`.git${path.sep}`)).sort();
};

const outcomeOf = async (run: () => Promise<unknown>): Promise<TsgitError['data'] | undefined> => {
  try {
    await run();
    return undefined;
  } catch (error) {
    return (error as TsgitError).data;
  }
};

const linesOf = (stdout: string): ReadonlyArray<string> =>
  stdout.split('\n').filter((line) => line !== '');

describe.skipIf(!GIT_AVAILABLE || !CASE_INSENSITIVE)(
  'mv porcelain interop on a case-insensitive host',
  () => {
    let pair: PeerPair;
    let repo: Repository;
    let ignorecase = 'true';

    const prepare = async (value: string): Promise<void> => {
      ignorecase = value;
      pair = await makePeerPair('mv-fold');
      runGit(['init', '-q', '-b', 'main', pair.peer]);
      repo = await openRepository({ cwd: pair.ours });
      await repo.init();
      runGit(['-C', pair.peer, 'config', 'core.ignorecase', value]);
      runGit(['-C', pair.ours, 'config', 'core.ignorecase', value]);
    };

    afterEach(async () => {
      await repo.dispose();
      await pair.dispose();
    });

    const writeBoth = async (file: string, tracked: boolean): Promise<void> => {
      for (const dir of [pair.peer, pair.ours]) {
        await mkdir(path.join(dir, path.dirname(file)), { recursive: true });
        await writeFile(path.join(dir, file), `${file}\n`);
      }
      if (!tracked) return;
      runGit(['-C', pair.peer, 'add', '--', file]);
      await repo.add([file]);
    };

    const seed = async (tracked: ReadonlyArray<string>, untracked: ReadonlyArray<string> = []) => {
      for (const file of tracked) await writeBoth(file, true);
      for (const file of untracked) await writeBoth(file, false);
    };

    const mkdirBoth = async (rel: string): Promise<void> => {
      await mkdir(path.join(pair.peer, rel), { recursive: true });
      await mkdir(path.join(pair.ours, rel), { recursive: true });
    };

    const expectParity = async (): Promise<void> => {
      expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
      expect(await diskEntries(pair.ours)).toEqual(await diskEntries(pair.peer));
    };

    describe.each(['true', 'false'])('Given core.ignorecase=%s', (value) => {
      beforeEach(() => prepare(value));

      describe('When a directory moves onto its own case variant (row 5)', () => {
        it('Then git and tsgit both refuse with the filesystem error and leave every entry', async () => {
          // Arrange
          await seed(['d/f', 'd/g'], ['d/u']);
          const stageBefore = lsStage(pair.ours);
          const diskBefore = await diskEntries(pair.ours);

          // Act
          const gitRun = tryRunGitWithExit(['-C', pair.peer, 'mv', 'd', 'D']);
          const data = await outcomeOf(() => repo.mv(['d'], 'D'));

          // Assert
          const reason = (data as { reason: string }).reason;
          expect(gitRun.exitCode).toBe(128);
          expect(gitRun.stderr).toContain(
            `renaming 'd' to 'D/d' failed: ${ERRNO_TEXT[reason] ?? reason}`,
          );
          expect(data).toMatchObject({ code: 'UNSUPPORTED_OPERATION', operation: 'filesystem' });
          expect(lsStage(pair.ours)).toBe(stageBefore);
          expect(lsStage(pair.peer)).toBe(stageBefore);
          expect(await diskEntries(pair.ours)).toEqual(diskBefore);
          expect(await diskEntries(pair.peer)).toEqual(diskBefore);
          await expectParity();
        });
      });

      describe('When a directory moves onto its case variant with skipErrors (row 5-k)', () => {
        it('Then git and tsgit both delete the source as git deletes it and record the entries under D/d', async () => {
          // Arrange
          await seed(['d/f', 'd/g', 'd/s/t'], ['d/u', 'd/s/u']);
          await mkdirBoth('d/emp');

          // Act
          const gitRun = tryRunGitWithExit(['-C', pair.peer, 'mv', '-k', '-v', 'd', 'D']);
          const result = await repo.mv(['d'], 'D', { skipErrors: true });

          // Assert
          expect(gitRun.exitCode).toBe(0);
          expect(result.skipped).toEqual([{ source: 'd', reason: 'rename-failed' }]);
          expect(linesOf(gitRun.stdout)).toEqual(
            mvVerboseLines(['d'], (source) => `D/${source}`, result, ['d']),
          );
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
          expect(lsStage(pair.ours)).toContain('D/d/f');
          for (const dir of [pair.peer, pair.ours]) expect(await diskEntries(dir)).toEqual([]);
        });
      });

      describe('When a directory holding a tracked directory moves onto a tracked sibling in another case (row 6-d)', () => {
        it('Then both refuse, or skip it under skipErrors, and change nothing', async () => {
          // Arrange
          await seed(['a/g', 'a/d/f']);
          const stageBefore = lsStage(pair.ours);

          // Act
          const gitRun = tryRunGitWithExit(['-C', pair.peer, 'mv', 'a/d', 'A']);
          const data = await outcomeOf(() => repo.mv(['a/d'], 'A'));
          const gitSkip = tryRunGitWithExit(['-C', pair.peer, 'mv', '-k', 'a/d', 'A']);
          const skipped = await repo.mv(['a/d'], 'A', { skipErrors: true });

          // Assert
          expect(gitRun.exitCode).toBe(128);
          expect(data).toMatchObject({
            code: 'MV_DESTINATION_EXISTS',
            source: 'a/d',
            destination: 'A/d',
          });
          expect(gitSkip.exitCode).toBe(0);
          expect(skipped.skipped).toEqual([{ source: 'a/d', reason: 'destination-exists' }]);
          expect(lsStage(pair.ours)).toBe(stageBefore);
          await expectParity();
        });
      });

      describe('When a directory moves onto a populated case variant under another parent (row L)', () => {
        const rowFiles = ['x/d/f', 'y/D/g', 'y/D/u', 'T/keep'];

        it.skipIf(process.platform === 'win32')(
          'Then without skipErrors both refuse after moving the first directory',
          async () => {
            // Arrange
            await seed(rowFiles);
            const stageBefore = lsStage(pair.ours);

            // Act
            const gitRun = tryRunGitWithExit(['-C', pair.peer, 'mv', 'x/d', 'y/D', 'T']);
            const data = await outcomeOf(() => repo.mv(['x/d', 'y/D'], 'T'));

            // Assert
            expect(gitRun.exitCode).toBe(128);
            expect(data).toMatchObject({ code: 'DIRECTORY_NOT_EMPTY' });
            expect(lsStage(pair.ours)).toBe(stageBefore);
            expect(lsStage(pair.peer)).toBe(stageBefore);
            expect(await pathExists(pair.ours, 'T/d/f')).toBe(true);
            expect(await pathExists(pair.peer, 'T/d/f')).toBe(true);
            await expectParity();
          },
        );

        it.skipIf(process.platform === 'win32')(
          'Then with skipErrors both skip the second directory and agree on index and disk',
          async () => {
            // Arrange
            await seed(rowFiles);

            // Act
            const gitRun = tryRunGitWithExit([
              '-C',
              pair.peer,
              'mv',
              '-k',
              '-v',
              'x/d',
              'y/D',
              'T',
            ]);
            const result = await repo.mv(['x/d', 'y/D'], 'T', { skipErrors: true });

            // Assert
            expect(gitRun.exitCode).toBe(0);
            expect(result.skipped).toEqual([{ source: 'y/D', reason: 'rename-failed' }]);
            expect(linesOf(gitRun.stdout)).toEqual(
              mvVerboseLines(['x/d', 'y/D'], (source) => `T/${path.basename(source)}`, result, [
                'x/d',
                'y/D',
              ]),
            );
            expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
            expect(lsStage(pair.ours)).toContain('T/D/g');
            expect(lsStage(pair.ours)).toContain('T/d/f');
            expect(await pathExists(pair.ours, 'y/D')).toBe(false);
            await expectParity();
          },
        );
      });
    });

    describe('Given core.ignorecase=true', () => {
      beforeEach(() => prepare('true'));

      describe('When git mv -n moves a directory onto its case variant (row 5-n)', () => {
        it('Then tsgit reports git Renaming lines minus the directory own line', async () => {
          // Arrange
          await seed(['d/f', 'd/g'], ['d/u']);

          // Act
          const gitRun = tryRunGitWithExit(['-C', pair.peer, 'mv', '-n', 'd', 'D']);
          const result = await repo.mv(['d'], 'D', { dryRun: true });

          // Assert
          const renameLines = linesOf(gitRun.stdout).filter((line) => line.startsWith('Renaming '));
          expect(gitRun.exitCode).toBe(0);
          expect(renameLines.slice(1)).toEqual(
            result.moved.map(({ from, to }) => `Renaming ${from} to ${to}`),
          );
        });
      });

      describe('When two directories move onto a case-variant target with skipErrors (row C)', () => {
        it('Then both twins delete both sources and agree on the index', async () => {
          // Arrange
          await seed(['d/f', 'd/s/t', 'e/e1'], ['d/u']);

          // Act
          const gitRun = tryRunGitWithExit(['-C', pair.peer, 'mv', '-k', '-v', 'd', 'e', 'D']);
          const result = await repo.mv(['d', 'e'], 'D', { skipErrors: true });

          // Assert
          expect(gitRun.exitCode).toBe(0);
          expect(linesOf(gitRun.stdout)).toEqual(
            mvVerboseLines(['d', 'e'], (source) => `D/${source}`, result, ['d', 'e']),
          );
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
          for (const dir of [pair.peer, pair.ours]) expect(await diskEntries(dir)).toEqual([]);
        });
      });

      describe.each([
        { id: 'row 6', files: ['f', 'd/g'], argv: ['f', 'F'], force: false },
        { id: 'row 6-prime', files: ['f', 'd/g'], argv: ['f', 'F'], force: true },
        { id: 'row 6 nested', files: ['f', 'd/g'], argv: ['d/g', 'd/G'], force: false },
        { id: 'row 6-f', files: ['a/g', 'a/d/f'], argv: ['a/g', 'A'], force: false },
      ])('When a file moves onto its case variant ($id)', (row) => {
        it('Then both succeed and agree on the index and the disk', async () => {
          // Arrange
          await seed(row.files);
          const [source, target] = row.argv as [string, string];

          // Act
          const gitArgs = row.force ? ['mv', '-f', source, target] : ['mv', source, target];
          runGit(['-C', pair.peer, ...gitArgs]);
          await repo.mv([source], target, { force: row.force });

          // Assert
          await expectParity();
        });
      });
    });

    describe('Given core.ignorecase=false', () => {
      beforeEach(() => prepare('false'));

      describe.each([
        { id: 'row 6', files: ['f', 'd/g'], argv: ['f', 'F'] },
        { id: 'row 6 nested', files: ['f', 'd/g'], argv: ['d/g', 'd/G'] },
        { id: 'row 6-f', files: ['a/g', 'a/d/f'], argv: ['a/g', 'A'] },
      ])('When a file moves onto its case variant ($id)', (row) => {
        it('Then both refuse and change nothing', async () => {
          // Arrange
          await seed(row.files);
          const [source, target] = row.argv as [string, string];
          const stageBefore = lsStage(pair.ours);

          // Act
          const gitRun = tryRunGitWithExit(['-C', pair.peer, 'mv', source, target]);
          const data = await outcomeOf(() => repo.mv([source], target));

          // Assert
          expect(ignorecase).toBe('false');
          expect(gitRun.exitCode).toBe(128);
          expect(data).toMatchObject({ code: 'MV_DESTINATION_EXISTS' });
          expect(lsStage(pair.ours)).toBe(stageBefore);
          await expectParity();
        });
      });

      describe('When mv -f moves a file onto its case variant (row 6-prime)', () => {
        it('Then both move it and agree on the index and the disk', async () => {
          // Arrange
          await seed(['f', 'd/g']);

          // Act
          runGit(['-C', pair.peer, 'mv', '-f', 'f', 'F']);
          await repo.mv(['f'], 'F', { force: true });

          // Assert
          await expectParity();
        });
      });
    });
  },
);
