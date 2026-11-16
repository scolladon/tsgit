/**
 * Cross-tool interop — a pathspec or a working-tree path is never refused for its
 * length: git and tsgit stage, remove, restore, grep, move and report long names
 * alike, and a long pathspec that names nothing ends in the same no-match outcome.
 *
 * @proves
 *   surface:        add
 *   bucket:         cross-tool-interop
 *   unique:         long pathspecs and long working-tree names are acted on, or not matched, as git does
 *   interopSurface: add, rm
 */
import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm as removeTree,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { add } from '../../src/application/commands/add.js';
import { checkout } from '../../src/application/commands/checkout.js';
import { grep } from '../../src/application/commands/grep.js';
import { rm } from '../../src/application/commands/rm.js';
import { pathspecNoMatch } from '../../src/domain/commands/error.js';
import { TsgitError } from '../../src/domain/error.js';
import { GIT_AVAILABLE, runGit, runGitEnv, tryRunGitWithExit } from './interop-helpers.js';

const P805 = `${['a', 'b', 'c', 'd'].map((c) => c.repeat(200)).join('/')}/x`; // 805 bytes, tracked
const DIR805 = P805.slice(0, -'/x'.length);
const M127 = 'm'.repeat(127);
const P256 = `${M127}/${'n'.repeat(128)}`; // tracked
const P257 = `${M127}/${'n'.repeat(129)}`; // tracked
const S255 = 's'.repeat(255); // tracked
const P5000 = Array.from({ length: 25 }, () => 'p'.repeat(200)).join('/'); // 5024 bytes, never on disk
const BASE = 'base';
const TRACKED = [BASE, P805, P256, P257, S255];
const FIVE_STARS = '**a**b**c**d**x';
const FOUR_STARS = '**a**b**c**x';
const TEN_STARS = '**********';
const GIT_EXIT_FATAL = 128;
const GIT_EXIT_ERROR = 1;

const snapshotOf = (repo: string) => ({
  index: runGit(['-C', repo, 'ls-files', '-s']),
  status: runGit(['-C', repo, 'status', '--porcelain', '--untracked-files=all']),
});

const gitSpec = (spec: string): string => (spec.startsWith('!') ? `:${spec}` : spec);

const filesOf = async (repo: string): Promise<string[]> =>
  (await readdir(repo, { recursive: true })).filter((name) => !name.startsWith('.git')).sort();

const caught = async (fn: () => Promise<unknown>): Promise<TsgitError> => {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(TsgitError);
    return err as TsgitError;
  }
  throw new Error('expected the call to throw');
};

describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')(
  'Given long pathspecs against a tracked long name',
  () => {
    let root = '';
    let pathMax = 0;
    let counter = 0;

    beforeAll(async () => {
      root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-pathspec-length-')));
      pathMax = Number(execFileSync('getconf', ['PATH_MAX', root]).toString().trim());
    });

    afterAll(async () => {
      await removeTree(root, { recursive: true, force: true });
    });

    const writeAt = async (repo: string, name: string, content: string): Promise<void> => {
      const length = path.join(repo, name).length;
      expect(length, `${name.length}-byte name, absolute length ${length}`).toBeLessThan(pathMax);
      await mkdir(path.dirname(path.join(repo, name)), { recursive: true });
      await writeFile(path.join(repo, name), content);
    };

    const twin = async (side: string, modified: ReadonlyArray<string>): Promise<string> => {
      counter += 1;
      const repo = path.join(root, `${side}-${counter}`);
      runGit(['init', '-q', '-b', 'main', repo]);
      for (const name of TRACKED) await writeAt(repo, name, 'needle\n');
      runGit(['-C', repo, 'add', '-A']);
      runGit(
        [
          '-C',
          repo,
          '-c',
          'user.name=t',
          '-c',
          'user.email=t@example.com',
          '-c',
          'commit.gpgsign=false',
          'commit',
          '-q',
          '-m',
          'm',
        ],
        { env: runGitEnv() },
      );
      for (const name of modified) await writeAt(repo, name, 'changed\n');
      return repo;
    };

    const twins = async (
      modified: ReadonlyArray<string>,
      untracked: ReadonlyArray<string> = [],
    ) => {
      const gitRepo = await twin('git', modified);
      const tsgitRepo = await twin('tsgit', modified);
      for (const name of untracked) {
        await writeAt(gitRepo, name, 'new\n');
        await writeAt(tsgitRepo, name, 'new\n');
      }
      return { gitRepo, tsgitRepo, ctx: createNodeContext({ workDir: tsgitRepo }) };
    };

    describe.each([
      { id: 'B1', specs: [P805], modified: [P805], untracked: [] },
      { id: 'B1', specs: [`${DIR805}/*`], modified: [P805], untracked: [`${DIR805}/y`] },
      {
        id: 'B1',
        specs: [`*${'b'.repeat(200)}/${'c'.repeat(200)}/${'d'.repeat(200)}/x`],
        modified: [P805],
        untracked: [],
      },
      { id: 'B1', specs: [`${DIR805}/`], modified: [P805], untracked: [] },
      { id: 'B2-P257', specs: [P257], modified: [P257], untracked: [] },
      { id: 'B2-P256', specs: [P256], modified: [P256], untracked: [] },
      { id: 'B3', specs: ['.', `!${P805}`], modified: [BASE, P805], untracked: [] },
      { id: 'T1', specs: [FIVE_STARS], modified: [P805], untracked: [] },
      { id: 'T2', specs: [TEN_STARS], modified: [BASE], untracked: [] },
      { id: 'T4', specs: [FOUR_STARS], modified: [P805], untracked: [] },
    ])('When git and tsgit add $specs (row $id)', (row) => {
      it('Then both leave the same index and status', async () => {
        // Arrange
        const { gitRepo, tsgitRepo, ctx } = await twins(row.modified, row.untracked);
        const sut = add;

        // Act
        runGit(['-C', gitRepo, 'add', '--', ...row.specs.map(gitSpec)]);
        await sut(ctx, row.specs);

        // Assert
        expect(snapshotOf(tsgitRepo)).toEqual(snapshotOf(gitRepo));
      });
    });

    describe.each([
      { id: 'B4', spec: `${DIR805}/nope` },
      { id: 'B4', spec: `${P805}/` },
      { id: 'T3', spec: '**/**/**/**/**/x' },
    ])('When git and tsgit add the unmatched $spec (row $id)', (row) => {
      it('Then both refuse it as matching nothing', async () => {
        // Arrange
        const { gitRepo, tsgitRepo, ctx } = await twins([P805]);
        const sut = add;

        // Act
        const gitRun = tryRunGitWithExit(['-C', gitRepo, 'add', '--', row.spec]);
        const err = await caught(() => sut(ctx, [row.spec]));

        // Assert
        expect(gitRun.exitCode).toBe(GIT_EXIT_FATAL);
        expect(err.data).toEqual(pathspecNoMatch(row.spec).data);
        expect(gitRun.stderr).toContain(`pathspec '${row.spec}' did not match`);
        expect(snapshotOf(tsgitRepo)).toEqual(snapshotOf(gitRepo));
      });
    });

    describe.each([
      { id: 'B5', spec: P805, cached: false },
      { id: 'B5', spec: P805, cached: true },
      { id: 'B5', spec: `${DIR805}/*`, cached: false },
      { id: 'T1', spec: FIVE_STARS, cached: false },
    ])('When git and tsgit remove $spec with cached $cached (row $id)', (row) => {
      it('Then both leave the same index and working tree', async () => {
        // Arrange
        const { gitRepo, tsgitRepo, ctx } = await twins([]);
        const sut = rm;

        // Act
        runGit(['-C', gitRepo, 'rm', '-q', ...(row.cached ? ['--cached'] : []), '--', row.spec]);
        await sut(ctx, [row.spec], { cached: row.cached });

        // Assert
        expect(snapshotOf(tsgitRepo)).toEqual(snapshotOf(gitRepo));
        expect(await filesOf(tsgitRepo)).toEqual(await filesOf(gitRepo));
      });
    });

    describe.each([
      { id: 'B6', spec: P805, source: undefined },
      { id: 'B6', spec: P805, source: 'HEAD' },
      { id: 'B6', spec: `${DIR805}/*`, source: undefined },
      { id: 'T1', spec: FIVE_STARS, source: undefined },
    ])('When git and tsgit restore $spec from $source (row $id)', (row) => {
      it('Then both restore the same content', async () => {
        // Arrange
        const { gitRepo, tsgitRepo, ctx } = await twins([P805]);
        const sut = checkout;
        const gitSource = row.source === undefined ? [] : [row.source];

        // Act
        runGit(['-C', gitRepo, 'checkout', ...gitSource, '--', row.spec]);
        await sut(ctx, {
          paths: [row.spec],
          ...(row.source === undefined ? {} : { source: row.source }),
        });

        // Assert
        expect(await readFile(path.join(tsgitRepo, P805), 'utf8')).toBe(
          await readFile(path.join(gitRepo, P805), 'utf8'),
        );
        expect(snapshotOf(tsgitRepo)).toEqual(snapshotOf(gitRepo));
      });
    });

    describe('When git and tsgit restore a long pathspec that names nothing (row B7)', () => {
      it('Then both refuse it as matching nothing', async () => {
        // Arrange
        const { gitRepo, tsgitRepo, ctx } = await twins([P805]);
        const spec = `${DIR805}/nope`;
        const sut = checkout;

        // Act
        const gitRun = tryRunGitWithExit(['-C', gitRepo, 'checkout', '--', spec]);
        const err = await caught(() => sut(ctx, { paths: [spec] }));

        // Assert
        expect(gitRun.exitCode).toBe(GIT_EXIT_ERROR);
        expect(err.data).toEqual(pathspecNoMatch(spec).data);
        expect(snapshotOf(tsgitRepo)).toEqual(snapshotOf(gitRepo));
      });
    });

    describe.each([
      { id: 'B8', spec: P805, head: false },
      { id: 'B8', spec: `${DIR805}/*`, head: false },
      { id: 'B8', spec: P805, head: true },
      { id: 'T1', spec: FIVE_STARS, head: false },
    ])('When git and tsgit grep $spec (head $head, row $id)', (row) => {
      it('Then both report the one hit', async () => {
        // Arrange
        const { gitRepo, ctx } = await twins([]);
        const sut = grep;
        const gitRev = row.head ? ['HEAD'] : [];

        // Act
        const result = await sut(ctx, {
          patterns: [/needle/],
          paths: [row.spec],
          ...(row.head ? { target: { treeish: 'HEAD' } } : {}),
        });
        const gitRun = tryRunGitWithExit([
          '-C',
          gitRepo,
          'grep',
          '-l',
          '-z',
          'needle',
          ...gitRev,
          '--',
          row.spec,
        ]);

        // Assert
        const gitHits = gitRun.stdout.split('\0').filter((name) => name !== '');
        const prefix = row.head ? 'HEAD:' : '';
        expect(result.paths.map((entry) => `${prefix}${entry.path}`)).toEqual(gitHits);
        expect(gitHits).toEqual([`${prefix}${P805}`]);
      });
    });

    describe('When git and tsgit grep a long pathspec that names nothing (row B9)', () => {
      it('Then neither reports a hit', async () => {
        // Arrange
        const { gitRepo, ctx } = await twins([]);
        const spec = `${DIR805}/nope`;
        const sut = grep;

        // Act
        const result = await sut(ctx, { patterns: [/needle/], paths: [spec] });
        const gitRun = tryRunGitWithExit(['-C', gitRepo, 'grep', '-l', 'needle', '--', spec]);

        // Assert
        expect(gitRun.exitCode).toBe(GIT_EXIT_ERROR);
        expect(result.paths).toEqual([]);
      });
    });

    describe.each([
      { id: 'C7', cached: false },
      { id: 'C7', cached: true },
    ])('When git and tsgit remove the unmatched P5000 with cached $cached (row $id)', (row) => {
      it('Then both refuse it as matching nothing', async () => {
        // Arrange
        const { gitRepo, tsgitRepo, ctx } = await twins([]);
        const sut = rm;

        // Act
        const gitRun = tryRunGitWithExit([
          '-C',
          gitRepo,
          'rm',
          ...(row.cached ? ['--cached'] : []),
          '--',
          P5000,
        ]);
        const err = await caught(() => sut(ctx, [P5000], { cached: row.cached }));

        // Assert
        expect(gitRun.exitCode).toBe(GIT_EXIT_FATAL);
        expect(err.data).toEqual(pathspecNoMatch(P5000).data);
        expect(snapshotOf(tsgitRepo)).toEqual(snapshotOf(gitRepo));
      });
    });

    describe.each([
      { id: 'C8', source: undefined },
      { id: 'C8', source: 'HEAD' },
    ])('When git and tsgit restore the unmatched P5000 from $source (row $id)', (row) => {
      it('Then both refuse it as matching nothing', async () => {
        // Arrange
        const { gitRepo, tsgitRepo, ctx } = await twins([]);
        const sut = checkout;
        const gitSource = row.source === undefined ? [] : [row.source];

        // Act
        const gitRun = tryRunGitWithExit(['-C', gitRepo, 'checkout', ...gitSource, '--', P5000]);
        const err = await caught(() =>
          sut(ctx, {
            paths: [P5000],
            ...(row.source === undefined ? {} : { source: row.source }),
          }),
        );

        // Assert
        expect(gitRun.exitCode).toBe(GIT_EXIT_ERROR);
        expect(err.data).toEqual(pathspecNoMatch(P5000).data);
        expect(snapshotOf(tsgitRepo)).toEqual(snapshotOf(gitRepo));
      });
    });

    describe('When git and tsgit grep the unmatched P5000 (row C9)', () => {
      it('Then neither reports a hit', async () => {
        // Arrange
        const { gitRepo, ctx } = await twins([]);
        const sut = grep;

        // Act
        const result = await sut(ctx, { patterns: [/needle/], paths: [P5000] });
        const gitRun = tryRunGitWithExit(['-C', gitRepo, 'grep', '-l', 'needle', '--', P5000]);

        // Assert
        expect(gitRun.exitCode).toBe(GIT_EXIT_ERROR);
        expect(result.paths).toEqual([]);
      });
    });

    describe('When git and tsgit remove P5000 planted only in the index (row I2)', () => {
      it('Then both drop it from the index', async () => {
        // Arrange
        const { gitRepo, tsgitRepo, ctx } = await twins([]);
        for (const repo of [gitRepo, tsgitRepo]) {
          const blob = runGit(['-C', repo, 'rev-parse', `HEAD:${BASE}`]).trim();
          runGit(['-C', repo, 'update-index', '--add', '--cacheinfo', `100644,${blob},${P5000}`]);
        }
        const sut = rm;

        // Act
        runGit(['-C', gitRepo, 'rm', '-q', '--cached', '--', P5000]);
        await sut(ctx, [P5000], { cached: true });

        // Assert
        expect(snapshotOf(tsgitRepo)).toEqual(snapshotOf(gitRepo));
        expect(runGit(['-C', tsgitRepo, 'ls-files']).split('\n')).not.toContain(P5000);
      });
    });
  },
);
