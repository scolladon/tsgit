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
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
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

  describe('Given an index that disagrees with the working tree', () => {
    const driftBoth = async (action: (dir: string) => Promise<void>): Promise<void> => {
      for (const dir of [pair.peer, pair.ours]) await action(dir);
    };

    const fileOverDirectory = (dir: string): Promise<void> =>
      rm(path.join(dir, 'x'), { recursive: true }).then(() =>
        writeFile(path.join(dir, 'x'), 'X\n'),
      );

    const directoryOverFile = async (dir: string): Promise<void> => {
      await rm(path.join(dir, 't'));
      await mkdir(path.join(dir, 't'));
      await writeFile(path.join(dir, 't', 'keep'), 'KEEP\n');
    };

    describe('When mv -f moves a file onto a path that is a file on disk and a directory in the index (rows Z15, Z16)', () => {
      it('Then the entries beneath leave the index as in git', async () => {
        // Arrange
        await seed([
          { path: 'f', content: 'F\n' },
          { path: 'x/y', content: 'Y\n' },
        ]);
        await driftBoth(fileOverDirectory);

        // Act
        runGit(['-C', pair.peer, 'mv', '-f', 'f', 'x']);
        await repo.mv(['f'], 'x', { force: true });

        // Assert
        expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
      });
    });

    describe.each([
      ['a forced file (row Z17)', ['-f', 'f', 't/keep'], ['f'], 't/keep', { force: true }],
      ['a plain file (row Z18)', ['f', 't/new'], ['f'], 't/new', {}],
      ['a directory (rows Z19, Z20)', ['dir', 't/d'], ['dir'], 't/d', {}],
    ] as const)(
      'When mv moves %s beneath a path that is a directory on disk and a file in the index',
      (_label, gitArgs, sources, destination, opts) => {
        it('Then the leading file leaves the index as in git', async () => {
          // Arrange
          await seed([
            { path: 'f', content: 'F\n' },
            { path: 't', content: 'T\n' },
            { path: 'dir/a', content: 'A\n' },
          ]);
          await driftBoth(directoryOverFile);

          // Act
          runGit(['-C', pair.peer, 'mv', ...gitArgs]);
          await repo.mv(sources, destination, opts);

          // Assert
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
        });
      },
    );
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

  describe('Given an untracked source path absent from the working tree', () => {
    describe('When repo.mv is asked to move it', () => {
      it('Then it refuses as a bad source like git mv and mutates nothing', async () => {
        // Arrange
        await seed([{ path: 'a.txt', content: 'hello\n' }]);
        const before = lsStage(pair.ours);

        // Act
        const gitRun = tryRunGitWithExit(['-C', pair.peer, 'mv', 'ghost.txt', 'dest.txt']);
        const data = await outcomeOf(() => repo.mv(['ghost.txt'], 'dest.txt'));

        // Assert
        expect(gitRun.exitCode).toBe(128);
        expect(data).toMatchObject({ code: 'MV_BAD_SOURCE' });
        const { source, destination } = data as { source: string; destination: string };
        expect(gitRun.stderr).toContain(
          `fatal: bad source, source=${source}, destination=${destination}`,
        );
        expect(lsStage(pair.ours)).toBe(before);
      });
    });
  });

  describe('Given an untracked source path present in the working tree', () => {
    describe('When repo.mv is asked to move it', () => {
      it('Then it refuses as not under version control like git mv and mutates nothing', async () => {
        // Arrange
        await seed([{ path: 'a.txt', content: 'hello\n' }]);
        await writeBoth({ path: 'loose.txt', content: 'loose\n' });
        const before = lsStage(pair.ours);

        // Act
        const gitRun = tryRunGitWithExit(['-C', pair.peer, 'mv', 'loose.txt', 'dest.txt']);
        const data = await outcomeOf(() => repo.mv(['loose.txt'], 'dest.txt'));

        // Assert
        expect(gitRun.exitCode).toBe(128);
        expect(data).toMatchObject({ code: 'MV_SOURCE_NOT_TRACKED' });
        const { source, destination } = data as { source: string; destination: string };
        expect(gitRun.stderr).toContain(
          `fatal: not under version control, source=${source}, destination=${destination}`,
        );
        expect(lsStage(pair.ours)).toBe(before);
      });
    });
  });

  describe('Given absent, untracked, tracked-then-removed and good sources into a directory', () => {
    describe('When repo.mv skips errors', () => {
      it('Then git and tsgit skip the same sources and agree on the index', async () => {
        // Arrange
        await seed([
          { path: 'gone', content: 'g\n' },
          { path: 'f', content: 'f\n' },
          { path: 'dir/keep', content: 'k\n' },
        ]);
        await writeBoth({ path: 'untracked', content: 'u\n' });
        for (const dir of [pair.peer, pair.ours]) await rm(path.join(dir, 'gone'));
        const sources = ['ghost', 'untracked', 'gone', 'f'];

        // Act
        const gitRun = tryRunGitWithExit(['-C', pair.peer, 'mv', '-k', '-v', ...sources, 'dir']);
        const result = await repo.mv(sources, 'dir', { skipErrors: true });

        // Assert
        expect(gitRun.exitCode).toBe(0);
        expect(result.skipped).toEqual([
          { source: 'ghost', reason: 'bad-source' },
          { source: 'untracked', reason: 'source-not-tracked' },
          { source: 'gone', reason: 'bad-source' },
        ]);
        expect(linesOf(gitRun.stdout)).toEqual(
          mvVerboseLines(sources, (source) => `dir/${source}`, result, []),
        );
        expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
      });
    });
  });

  describe('Given a source directory without a tracked member', () => {
    const seedDirectories = async (): Promise<void> => {
      await seed([
        { path: 'f', content: 'f\n' },
        { path: 'dir/keep', content: 'k\n' },
      ]);
      await writeBoth({ path: 'ud/u', content: 'u\n' });
      for (const dir of [pair.peer, pair.ours]) await mkdir(path.join(dir, 'emp'));
    };

    describe.each([{ source: 'ud' }, { source: 'emp' }])(
      'When repo.mv is asked to move $source',
      ({ source }) => {
        it('Then it refuses as an empty source directory like git mv and mutates nothing', async () => {
          // Arrange
          await seedDirectories();
          const before = lsStage(pair.ours);

          // Act
          const gitRun = tryRunGitWithExit(['-C', pair.peer, 'mv', source, 'z']);
          const data = await outcomeOf(() => repo.mv([source], 'z'));

          // Assert
          expect(gitRun.exitCode).toBe(128);
          expect(data).toMatchObject({ code: 'MV_SOURCE_DIRECTORY_EMPTY', source });
          const { destination } = data as { destination: string };
          expect(gitRun.stderr).toContain(
            `fatal: source directory is empty, source=${source}, destination=${destination}`,
          );
          expect(lsStage(pair.ours)).toBe(before);
          expect(await pathExists(pair.ours, 'ud/u')).toBe(true);
          expect(await pathExists(pair.ours, 'emp')).toBe(true);
        });
      },
    );

    describe('When repo.mv skips errors', () => {
      it('Then git and tsgit skip both directories, move the file and agree on disk', async () => {
        // Arrange
        await seedDirectories();
        const sources = ['ud', 'emp', 'f'];

        // Act
        const gitRun = tryRunGitWithExit(['-C', pair.peer, 'mv', '-k', '-v', ...sources, 'dir']);
        const result = await repo.mv(sources, 'dir', { skipErrors: true });

        // Assert
        expect(gitRun.exitCode).toBe(0);
        expect(result.skipped).toEqual([
          { source: 'ud', reason: 'source-directory-empty' },
          { source: 'emp', reason: 'source-directory-empty' },
        ]);
        expect(linesOf(gitRun.stdout)).toEqual(
          mvVerboseLines(sources, (source) => `dir/${source}`, result, []),
        );
        expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
        for (const dir of [pair.peer, pair.ours]) {
          expect(await pathExists(dir, 'ud/u')).toBe(true);
          expect(await pathExists(dir, 'emp')).toBe(true);
          expect(await pathExists(dir, 'dir/f')).toBe(true);
        }
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

    const seedLongDirectoryTwins = async () => {
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
      return { gitRepo, tsgitRepo, dest, steps };
    };

    describe('When git and tsgit skip errors moving a long directory and a file under a deep destination (row H)', () => {
      it('Then both move the file, refuse the directory and agree on the index and the disk', async () => {
        // Arrange
        const { gitRepo, tsgitRepo, dest, steps } = await seedLongDirectoryTwins();
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

    describe('When git and tsgit move the long directory first without skipErrors (row J)', () => {
      it('Then both refuse naming the directory destination and move nothing', async () => {
        // Arrange
        const { gitRepo, tsgitRepo, dest } = await seedLongDirectoryTwins();
        const stageBefore = stageOf(tsgitRepo);
        const sut = await openTrackedRepository(tsgitRepo);

        // Act
        const gitRun = tryRunGitWithExit(['-C', gitRepo, 'mv', '--', L200, 'b', dest]);
        const data = await sut.mv([L200, 'b'], dest).then(
          () => undefined,
          (err: unknown) => (err as TsgitError).data,
        );

        // Assert
        expect(gitRun.exitCode).toBe(128);
        expect(gitRun.stderr).toContain(
          `renaming '${L200}' to '${dest}/${L200}' failed: File name too long`,
        );
        expect(data).toEqual({ code: 'PATH_TOO_LONG', path: `${dest}/${L200}` });
        expect(stageOf(tsgitRepo)).toEqual(stageBefore);
        expect(stageOf(gitRepo)).toEqual(stageBefore);
        for (const dir of [gitRepo, tsgitRepo]) {
          expect(await pathExists(dir, L200)).toBe(true);
          expect(await pathExists(dir, 'b')).toBe(true);
        }
      });
    });

    describe('When git and tsgit skip errors moving the file before the long directory (row K)', () => {
      it('Then both move the file, skip the directory, delete it and agree on the index', async () => {
        // Arrange
        const { gitRepo, tsgitRepo, dest, steps } = await seedLongDirectoryTwins();
        const sut = await openTrackedRepository(tsgitRepo);

        // Act
        const gitRun = tryRunGitWithExit(['-C', gitRepo, 'mv', '-k', '-v', '--', 'b', L200, dest]);
        const result = await sut.mv(['b', L200], dest, { skipErrors: true });

        // Assert
        expect(gitRun.exitCode).toBe(0);
        expect(result.skipped).toEqual([{ source: L200, reason: 'rename-failed' }]);
        expect(gitRun.stdout.split('\n').filter((line) => line !== '')).toEqual(
          mvVerboseLines(['b', L200], (source) => `${dest}/${source}`, result, [L200]),
        );
        expect(stageOf(tsgitRepo)).toEqual(stageOf(gitRepo));
        for (const dir of [gitRepo, tsgitRepo]) {
          expect(await pathExists(dir, L200)).toBe(false);
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
            expect(gitRun.stderr).toContain("renaming 'y/D' to 'T/D' failed: Directory not empty");
            expect(data).toEqual({ code: 'DIRECTORY_NOT_EMPTY', path: 'y/D' });
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
          expect(result.skipped).toEqual([{ source: 'd', reason: 'rename-failed' }]);
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

describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')(
  'mv porcelain interop beyond a symbolic link',
  () => {
    let pair: PeerPair;
    let repo: Repository;

    beforeEach(async () => {
      pair = await makePeerPair('mv-beyond-link');
      runGit(['init', '-q', '-b', 'main', pair.peer]);
      repo = await openRepository({ cwd: pair.ours });
      await repo.init();
    });

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

    const seed = async (tracked: ReadonlyArray<string>): Promise<void> => {
      for (const file of tracked) await writeBoth(file, true);
      for (const dir of [pair.peer, pair.ours]) {
        await mkdir(path.join(dir, '.git', 'hooks'), { recursive: true });
      }
    };

    const linkBoth = async (name: string, target: string, tracked: boolean): Promise<void> => {
      for (const dir of [pair.peer, pair.ours]) {
        await symlink(target, path.join(dir, name));
      }
      if (!tracked) return;
      runGit(['-C', pair.peer, 'add', '--', name]);
      await repo.add([name]);
    };

    // The listing follows `lnk` into each twin's own .git, whose sample hooks differ by tool;
    // what moved through the link is asserted at its .git path.
    const workTreeEntries = async (dir: string): Promise<ReadonlyArray<string>> =>
      (await diskEntries(dir)).filter((entry) => !entry.startsWith(`lnk${path.sep}`));

    const expectParity = async (): Promise<void> => {
      expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
      expect(await workTreeEntries(pair.ours)).toEqual(await workTreeEntries(pair.peer));
    };

    const beyondLinkLine = (data: unknown): string => {
      const { source, destination } = data as { source: string; destination: string };
      return `fatal: destination is beyond a symbolic link, source=${source}, destination=${destination}`;
    };

    const expectBeyondLink = async (
      args: ReadonlyArray<string>,
      run: () => Promise<unknown>,
      expected: { readonly source: string; readonly destination: string },
    ): Promise<void> => {
      const stageBefore = lsStage(pair.ours);
      const diskBefore = await workTreeEntries(pair.ours);

      const gitRun = tryRunGitWithExit(['-C', pair.peer, 'mv', ...args]);
      const data = await outcomeOf(run);

      expect(gitRun.exitCode).toBe(128);
      expect(data).toMatchObject({ code: 'MV_DESTINATION_BEYOND_SYMLINK', ...expected });
      expect(gitRun.stderr).toContain(beyondLinkLine(data));
      expect(lsStage(pair.ours)).toBe(stageBefore);
      expect(await workTreeEntries(pair.ours)).toEqual(diskBefore);
      await expectParity();
    };

    const seedLinkedRepo = async (): Promise<void> => {
      await seed(['dir/a', 'dir/b', 'f', 'sub/keep']);
      await linkBoth('lnk', '.git', true);
      await linkBoth('inner', 'sub', true);
      await linkBoth('dang', 'nowhere', true);
      await linkBoth('pointer', 'f', true);
    };

    describe('Given an untracked dangling link', () => {
      beforeEach(async () => {
        await seed(['f']);
        await linkBoth('dl2', 'nowhere', false);
      });

      describe('When it is moved (row U6)', () => {
        it('Then git and tsgit refuse it as not under version control', async () => {
          // Arrange
          const sut = repo;
          const stageBefore = lsStage(pair.ours);

          // Act
          const gitRun = tryRunGitWithExit(['-C', pair.peer, 'mv', 'dl2', 'z']);
          const data = await outcomeOf(() => sut.mv(['dl2'], 'z'));

          // Assert
          expect(gitRun.exitCode).toBe(128);
          expect(data).toMatchObject({ code: 'MV_SOURCE_NOT_TRACKED', source: 'dl2' });
          expect(gitRun.stderr).toContain('fatal: not under version control, source=dl2');
          expect(lsStage(pair.ours)).toBe(stageBefore);
          await expectParity();
        });
      });
    });

    describe('Given a tracked link to the git directory', () => {
      beforeEach(seedLinkedRepo);

      describe('When a directory moves beyond the link (row Y1)', () => {
        it('Then git and tsgit refuse naming the first member and write nothing', async () => {
          // Arrange
          const sut = repo;

          // Act & Assert
          await expectBeyondLink(['dir', 'lnk/hooks/x'], () => sut.mv(['dir'], 'lnk/hooks/x'), {
            source: 'dir/a',
            destination: 'lnk/hooks/x/a',
          });
          for (const dir of [pair.peer, pair.ours]) {
            expect(await pathExists(dir, '.git/hooks/x/a')).toBe(false);
          }
        });
      });

      describe.each([false, true])(
        'When a file moves beyond the link, force=%s (row Y2)',
        (force) => {
          it('Then git and tsgit refuse naming the file and write nothing', async () => {
            // Arrange
            const sut = repo;
            const args = force
              ? ['-f', 'f', 'lnk/hooks/pre-commit']
              : ['f', 'lnk/hooks/pre-commit'];

            // Act & Assert
            await expectBeyondLink(args, () => sut.mv(['f'], 'lnk/hooks/pre-commit', { force }), {
              source: 'f',
              destination: 'lnk/hooks/pre-commit',
            });
            for (const dir of [pair.peer, pair.ours]) {
              expect(await pathExists(dir, '.git/hooks/pre-commit')).toBe(false);
            }
          });
        },
      );

      describe('When skipErrors moves a directory beyond the link (row Y3)', () => {
        it('Then both rename it through the link, keep the index and tsgit skips each member', async () => {
          // Arrange
          const sut = repo;
          const stageBefore = lsStage(pair.ours);

          // Act
          const gitRun = tryRunGitWithExit([
            '-C',
            pair.peer,
            'mv',
            '-k',
            '-v',
            'dir',
            'lnk/hooks/y',
          ]);
          const result = await sut.mv(['dir'], 'lnk/hooks/y', { skipErrors: true });

          // Assert
          expect(gitRun.exitCode).toBe(0);
          expect(result.moved).toEqual([]);
          expect(result.skipped).toEqual([
            { source: 'dir/a', reason: 'destination-beyond-symlink' },
            { source: 'dir/b', reason: 'destination-beyond-symlink' },
          ]);
          expect(linesOf(gitRun.stdout)).toEqual(
            mvVerboseLines(['dir'], () => 'lnk/hooks/y', result, ['dir']),
          );
          expect(lsStage(pair.ours)).toBe(stageBefore);
          for (const dir of [pair.peer, pair.ours]) {
            expect(await pathExists(dir, 'dir')).toBe(false);
            expect(await pathExists(dir, '.git/hooks/y/a')).toBe(true);
          }
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
        });
      });

      describe('When skipErrors moves a file beyond the link (row Y4)', () => {
        it('Then git prints nothing, tsgit skips it and nothing changes', async () => {
          // Arrange
          const sut = repo;
          const stageBefore = lsStage(pair.ours);
          const diskBefore = await workTreeEntries(pair.ours);

          // Act
          const gitRun = tryRunGitWithExit([
            '-C',
            pair.peer,
            'mv',
            '-k',
            '-v',
            'f',
            'lnk/hooks/pre-commit',
          ]);
          const result = await sut.mv(['f'], 'lnk/hooks/pre-commit', { skipErrors: true });

          // Assert
          expect(gitRun.exitCode).toBe(0);
          expect(gitRun.stdout).toBe('');
          expect(result).toEqual({
            moved: [],
            skipped: [{ source: 'f', reason: 'destination-beyond-symlink' }],
          });
          expect(mvVerboseLines(['f'], () => 'lnk/hooks/pre-commit', result, [])).toEqual([]);
          expect(lsStage(pair.ours)).toBe(stageBefore);
          expect(await workTreeEntries(pair.ours)).toEqual(diskBefore);
          await expectParity();
        });
      });

      describe('When skipErrors moves a directory and an absent source into the link (row Y5)', () => {
        it('Then git prints one line and both rename the directory through the link', async () => {
          // Arrange
          const sut = repo;

          // Act
          const gitRun = tryRunGitWithExit([
            '-C',
            pair.peer,
            'mv',
            '-k',
            '-v',
            'dir',
            'f2',
            'lnk/hooks',
          ]);
          const result = await sut.mv(['dir', 'f2'], 'lnk/hooks', { skipErrors: true });

          // Assert
          expect(gitRun.exitCode).toBe(0);
          expect(linesOf(gitRun.stdout)).toHaveLength(1);
          expect(linesOf(gitRun.stdout)).toEqual(
            mvVerboseLines(['dir', 'f2'], (source) => `lnk/hooks/${source}`, result, ['dir']),
          );
          for (const dir of [pair.peer, pair.ours]) {
            expect(await pathExists(dir, '.git/hooks/dir/a')).toBe(true);
          }
          await expectParity();
        });
      });

      describe('When a file moves to a destination naming the link plus a slash (row Y10)', () => {
        it('Then git and tsgit refuse naming the destination inside the link', async () => {
          // Arrange
          const sut = repo;

          // Act & Assert
          await expectBeyondLink(['f', 'inner/'], () => sut.mv(['f'], 'inner/'), {
            source: 'f',
            destination: 'inner/f',
          });
        });
      });
    });

    describe('Given a tracked link to a directory inside the work tree', () => {
      beforeEach(seedLinkedRepo);

      describe.each([
        ['a file (row Y6)', ['f'], 'inner/g', 'f', 'inner/g'],
        ['a directory (row Y6)', ['dir'], 'inner/x', 'dir/a', 'inner/x/a'],
        ['a file below a dangling link (row Y8)', ['f'], 'dang/x', 'f', 'dang/x'],
        ['a file below a link to a file (row Y8)', ['f'], 'pointer/x', 'f', 'pointer/x'],
      ] as const)(
        'When %s moves beyond the link',
        (_label, sources, destination, source, expected) => {
          it('Then git and tsgit refuse naming the pair and write nothing', async () => {
            // Arrange
            const sut = repo;

            // Act & Assert
            await expectBeyondLink([...sources, destination], () => sut.mv(sources, destination), {
              source,
              destination: expected,
            });
          });
        },
      );

      describe('When skipErrors moves a directory beyond the link (row Y7)', () => {
        it('Then both leave the members untracked under the link target and keep the index', async () => {
          // Arrange
          const sut = repo;
          const stageBefore = lsStage(pair.ours);

          // Act
          const gitRun = tryRunGitWithExit(['-C', pair.peer, 'mv', '-k', '-v', 'dir', 'inner/x']);
          const result = await sut.mv(['dir'], 'inner/x', { skipErrors: true });

          // Assert
          expect(gitRun.exitCode).toBe(0);
          expect(linesOf(gitRun.stdout)).toEqual(
            mvVerboseLines(['dir'], () => 'inner/x', result, ['dir']),
          );
          for (const dir of [pair.peer, pair.ours]) {
            expect(await pathExists(dir, 'sub/x/a')).toBe(true);
          }
          expect(lsStage(pair.ours)).toBe(stageBefore);
          await expectParity();
        });
      });

      describe('When a directory moves beyond a link into the directory with a slash (rows Y10, Y11)', () => {
        it('Then git and tsgit refuse without skipErrors', async () => {
          // Arrange
          const sut = repo;

          // Act & Assert
          await expectBeyondLink(['dir', 'inner/'], () => sut.mv(['dir'], 'inner/'), {
            source: 'dir/a',
            destination: 'inner/dir/a',
          });
        });

        it('Then both move the directory and keep the file with skipErrors', async () => {
          // Arrange
          const sut = repo;

          // Act
          const gitRun = tryRunGitWithExit([
            '-C',
            pair.peer,
            'mv',
            '-k',
            '-v',
            'dir',
            'f',
            'inner/',
          ]);
          const result = await sut.mv(['dir', 'f'], 'inner/', { skipErrors: true });

          // Assert
          expect(gitRun.exitCode).toBe(0);
          expect(linesOf(gitRun.stdout)).toHaveLength(1);
          expect(linesOf(gitRun.stdout)).toEqual(
            mvVerboseLines(['dir', 'f'], (source) => `inner/${source}`, result, ['dir']),
          );
          for (const dir of [pair.peer, pair.ours]) {
            expect(await pathExists(dir, 'sub/dir/a')).toBe(true);
            expect(await pathExists(dir, 'f')).toBe(true);
          }
          await expectParity();
        });
      });

      describe.each(['dang/', 'pointer/'])(
        'When a file moves to %s, a link that is no directory (row Y12)',
        (destination) => {
          it('Then git and tsgit refuse as the directory missing naming the destination', async () => {
            // Arrange
            const sut = repo;

            // Act
            const gitRun = tryRunGitWithExit(['-C', pair.peer, 'mv', 'f', destination]);
            const data = await outcomeOf(() => sut.mv(['f'], destination));

            // Assert
            expect(gitRun.exitCode).toBe(128);
            expect(data).toMatchObject({
              code: 'MV_DESTINATION_DIRECTORY_MISSING',
              destination,
            });
            expect(gitRun.stderr).toContain(
              `fatal: destination directory does not exist, source=f, destination=${destination}`,
            );
            await expectParity();
          });
        },
      );

      describe('When a dry run moves a directory beyond the link (row Y13)', () => {
        it('Then git and tsgit refuse, and with skipErrors both return and change nothing', async () => {
          // Arrange
          const sut = repo;
          await expectBeyondLink(
            ['-n', 'dir', 'inner/x'],
            () => sut.mv(['dir'], 'inner/x', { dryRun: true }),
            { source: 'dir/a', destination: 'inner/x/a' },
          );

          // Act
          const gitRun = tryRunGitWithExit(['-C', pair.peer, 'mv', '-n', '-k', 'dir', 'inner/x']);
          const result = await sut.mv(['dir'], 'inner/x', { dryRun: true, skipErrors: true });

          // Assert
          expect(gitRun.exitCode).toBe(0);
          expect(result.moved).toEqual([]);
          for (const dir of [pair.peer, pair.ours]) {
            expect(await pathExists(dir, 'dir/a')).toBe(true);
            expect(await pathExists(dir, 'sub/x')).toBe(false);
          }
          await expectParity();
        });
      });
    });

    describe('an existing destination reached through a link', () => {
      const seedTarget = async (trackedTarget: boolean, trackedLink: boolean): Promise<void> => {
        await seed(['dir/a', 'f']);
        await writeBoth('sub/keep', trackedTarget);
        await writeBoth('sub/f', false);
        await linkBoth('inner', 'sub', trackedLink);
      };

      const keptContent = async (): Promise<ReadonlyArray<string>> => [
        await readFile(path.join(pair.peer, 'sub', 'keep'), 'utf8'),
        await readFile(path.join(pair.ours, 'sub', 'keep'), 'utf8'),
      ];

      const existsLine = (data: unknown, phrase: string): string => {
        const { source, destination } = data as { source: string; destination: string };
        return `fatal: ${phrase}, source=${source}, destination=${destination}`;
      };

      describe.each([
        [true, true],
        [false, true],
        [true, false],
      ])('Given tracked target %s, tracked link %s', (trackedTarget, trackedLink) => {
        beforeEach(() => seedTarget(trackedTarget, trackedLink));

        describe('When a file moves onto it without force (rows Y17, Z1, Z4)', () => {
          it('Then git and tsgit refuse as an existing destination and write nothing', async () => {
            // Arrange
            const sut = repo;
            const stageBefore = lsStage(pair.ours);

            // Act
            const gitRun = tryRunGitWithExit(['-C', pair.peer, 'mv', 'f', 'inner/keep']);
            const data = await outcomeOf(() => sut.mv(['f'], 'inner/keep'));

            // Assert
            expect(gitRun.exitCode).toBe(128);
            expect(data).toMatchObject({
              code: 'MV_DESTINATION_EXISTS',
              source: 'f',
              destination: 'inner/keep',
            });
            expect(gitRun.stderr).toContain(existsLine(data, 'destination exists'));
            expect(lsStage(pair.ours)).toBe(stageBefore);
            await expectParity();
          });
        });

        describe('When a file moves onto it with force (rows Y17, Z1, Z4)', () => {
          it('Then both overwrite the file behind the link and agree on the index', async () => {
            // Arrange
            const sut = repo;

            // Act
            runGit(['-C', pair.peer, 'mv', '-f', 'f', 'inner/keep']);
            const result = await sut.mv(['f'], 'inner/keep', { force: true });

            // Assert
            expect(result.moved).toEqual([{ from: 'f', to: 'inner/keep' }]);
            expect(await keptContent()).toEqual(['f\n', 'f\n']);
            await expectParity();
          });
        });
      });

      describe('Given the existing destination and a source directory', () => {
        beforeEach(() => seedTarget(true, true));

        describe.each([false, true])(
          'When a directory moves onto it, force=%s (row Z2)',
          (force) => {
            it('Then git and tsgit refuse as an existing destination', async () => {
              // Arrange
              const sut = repo;
              const args = force ? ['-f', 'dir', 'inner/keep'] : ['dir', 'inner/keep'];

              // Act
              const gitRun = tryRunGitWithExit(['-C', pair.peer, 'mv', ...args]);
              const data = await outcomeOf(() => sut.mv(['dir'], 'inner/keep', { force }));

              // Assert
              expect(gitRun.exitCode).toBe(128);
              expect(data).toMatchObject({ code: 'MV_DESTINATION_EXISTS' });
              expect(gitRun.stderr).toContain(existsLine(data, 'destination already exists'));
              await expectParity();
            });
          },
        );

        describe('When skipErrors moves a file onto it (row Z5)', () => {
          it('Then git prints nothing, tsgit skips it and nothing changes', async () => {
            // Arrange
            const sut = repo;

            // Act
            const gitRun = tryRunGitWithExit([
              '-C',
              pair.peer,
              'mv',
              '-k',
              '-v',
              'f',
              'inner/keep',
            ]);
            const result = await sut.mv(['f'], 'inner/keep', { skipErrors: true });

            // Assert
            expect(gitRun.exitCode).toBe(0);
            expect(gitRun.stdout).toBe('');
            expect(result).toEqual({
              moved: [],
              skipped: [{ source: 'f', reason: 'destination-exists' }],
            });
            await expectParity();
          });
        });

        describe('When a dry run with force moves a file onto it (row Z7)', () => {
          it('Then both report the move and change nothing', async () => {
            // Arrange
            const sut = repo;
            const stageBefore = lsStage(pair.ours);

            // Act
            const gitRun = tryRunGitWithExit([
              '-C',
              pair.peer,
              'mv',
              '-n',
              '-f',
              'f',
              'inner/keep',
            ]);
            const result = await sut.mv(['f'], 'inner/keep', { dryRun: true, force: true });

            // Assert
            expect(gitRun.exitCode).toBe(0);
            expect(result.moved).toEqual([{ from: 'f', to: 'inner/keep' }]);
            expect(lsStage(pair.ours)).toBe(stageBefore);
            expect(await keptContent()).toEqual(['sub/keep\n', 'sub/keep\n']);
            await expectParity();
          });
        });

        describe('When a file moves into the linked directory holding the same name (rows Z11, Z12)', () => {
          it('Then git and tsgit refuse as an existing destination', async () => {
            // Arrange
            const sut = repo;

            // Act
            const gitRun = tryRunGitWithExit(['-C', pair.peer, 'mv', 'f', 'inner/']);
            const data = await outcomeOf(() => sut.mv(['f'], 'inner/'));

            // Assert
            expect(gitRun.exitCode).toBe(128);
            expect(data).toMatchObject({ code: 'MV_DESTINATION_EXISTS', destination: 'inner/f' });
            expect(gitRun.stderr).toContain(existsLine(data, 'destination exists'));
            await expectParity();
          });
        });
      });

      describe('Given a link two levels down', () => {
        describe('When a file is forced through the deeper link (row Z9)', () => {
          it('Then that link leaves the index and the shallower one stays', async () => {
            // Arrange
            const sut = repo;
            await seedTarget(true, true);
            for (const dir of [pair.peer, pair.ours]) {
              await mkdir(path.join(dir, 'deep', 'real'), { recursive: true });
            }
            await linkBoth('deep/real/dl', '../../sub', true);

            // Act
            runGit(['-C', pair.peer, 'mv', '-f', 'f', 'deep/real/dl/keep']);
            await sut.mv(['f'], 'deep/real/dl/keep', { force: true });

            // Assert
            expect(lsStage(pair.ours)).not.toContain('deep/real/dl\n');
            expect(lsStage(pair.ours)).toContain('inner');
            await expectParity();
          });
        });
      });
    });

    describe('Given a tracked link to the git directory and an existing file behind it', () => {
      describe('When a file is forced onto it (row Z21)', () => {
        it('Then both overwrite the file inside the git directory', async () => {
          // Arrange
          const sut = repo;
          await seed(['f']);
          await linkBoth('lnk', '.git', true);
          for (const dir of [pair.peer, pair.ours]) {
            await writeFile(path.join(dir, '.git', 'description'), 'original\n');
          }

          // Act
          runGit(['-C', pair.peer, 'mv', '-f', 'f', 'lnk/description']);
          await sut.mv(['f'], 'lnk/description', { force: true });

          // Assert
          for (const dir of [pair.peer, pair.ours]) {
            await expect(readFile(path.join(dir, '.git', 'description'), 'utf8')).resolves.toBe(
              'f\n',
            );
          }
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
        });
      });
    });

    describe('Given a tracked link inside the directory being moved', () => {
      describe('When the directory moves into itself through the link (row Y15)', () => {
        it('Then git and tsgit refuse as into-self', async () => {
          // Arrange
          const sut = repo;
          await seed(['dir/a', 'sub/keep']);
          await linkBoth('dir/l', '../sub', true);

          // Act
          const gitRun = tryRunGitWithExit(['-C', pair.peer, 'mv', 'dir', 'dir/l/x']);
          const data = await outcomeOf(() => sut.mv(['dir'], 'dir/l/x'));

          // Assert
          expect(gitRun.exitCode).toBe(128);
          expect(data).toMatchObject({
            code: 'MV_INTO_SELF',
            source: 'dir',
            destination: 'dir/l/x',
          });
          expect(gitRun.stderr).toContain(
            'fatal: can not move directory into itself, source=dir, destination=dir/l/x',
          );
          await expectParity();
        });
      });
    });

    describe('Given a skipped file whose index entry another move replaces', () => {
      describe('When skipErrors and force move b and D/b/k into D/ with D/b a link to a read-only directory', () => {
        it('Then both exit 0 with the index {D/b} and keep what the link leads to', async () => {
          // Arrange
          const sut = repo;
          await seed(['D/b/k', 'b']);
          for (const dir of [pair.peer, pair.ours]) {
            await rename(path.join(dir, 'D', 'b'), path.join(dir, 'realdir'));
            await symlink('../realdir', path.join(dir, 'D', 'b'));
            await chmod(path.join(dir, 'realdir'), 0o555);
          }

          // Act
          const gitRun = tryRunGitWithExit(['-C', pair.peer, 'mv', '-k', '-f', 'b', 'D/b/k', 'D/']);
          const outcome = await sut
            .mv(['b', 'D/b/k'], 'D/', { skipErrors: true, force: true })
            .then(() => 'resolved')
            .catch((err: unknown) => err);
          for (const dir of [pair.peer, pair.ours]) await chmod(path.join(dir, 'realdir'), 0o755);

          // Assert
          expect(gitRun.exitCode).toBe(0);
          expect(outcome).toBe('resolved');
          expect(lsStage(pair.ours)).toBe(lsStage(pair.peer));
          for (const dir of [pair.peer, pair.ours]) {
            await expect(readFile(path.join(dir, 'realdir', 'k'), 'utf8')).resolves.toBe('D/b/k\n');
          }
        });
      });
    });
  },
);
