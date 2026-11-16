/**
 * Cross-tool interop — a pathspec or a working-tree path is never refused for its
 * length: git and tsgit stage, remove, restore, grep, move and report long names
 * alike, and a long pathspec that names nothing ends in the same no-match outcome.
 *
 * @proves
 *   surface:        add
 *   bucket:         cross-tool-interop
 *   unique:         long pathspecs and long working-tree names are acted on, or not matched, as git does
 *   interopSurface: add, rm, mv
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { blame } from '../../src/application/commands/blame.js';
import { checkout } from '../../src/application/commands/checkout.js';
import { grep } from '../../src/application/commands/grep.js';
import { mv } from '../../src/application/commands/mv.js';
import { rm } from '../../src/application/commands/rm.js';
import { status } from '../../src/application/commands/status.js';
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
const S300 = 's'.repeat(300); // no host holds a 300-byte component
const CJK100 = '\u6f22'.repeat(100); // 300 UTF-8 bytes, 100 characters
const BASE = 'base';
const TRACKED = [BASE, P805, P256, P257, S255];
const FIVE_STARS = '**a**b**c**d**x';
const FOUR_STARS = '**a**b**c**x';
const TEN_STARS = '**********';
const GIT_EXIT_FATAL = 128;
const GIT_EXIT_ERROR = 1;

const hostCanHoldWideComponent = (): boolean => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tsgit-wide-probe-'));
  try {
    writeFileSync(path.join(dir, CJK100), 'x');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const canHoldWideComponent = hostCanHoldWideComponent();

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

    const twin = async (
      side: string,
      modified: ReadonlyArray<string>,
      extraTracked: ReadonlyArray<string>,
    ): Promise<string> => {
      counter += 1;
      const repo = path.join(root, `${side}-${counter}`);
      runGit(['init', '-q', '-b', 'main', repo]);
      for (const name of [...TRACKED, ...extraTracked]) await writeAt(repo, name, 'needle\n');
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
      extraTracked: ReadonlyArray<string> = [],
    ) => {
      const gitRepo = await twin('git', modified, extraTracked);
      const tsgitRepo = await twin('tsgit', modified, extraTracked);
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
      { id: 'C7', label: 'P5000', spec: P5000, cached: false },
      { id: 'C7', label: 'P5000', spec: P5000, cached: true },
      { id: 'C7', label: 'S300', spec: S300, cached: false },
      { id: 'C7', label: 'S300', spec: S300, cached: true },
      { id: 'C7', label: 'S300 glob', spec: `${S300}*`, cached: false },
      { id: 'C7', label: 'S300 glob', spec: `${S300}*`, cached: true },
      { id: 'C7', label: 'S300 slash x', spec: `${S300}/x`, cached: false },
      { id: 'C7', label: 'S300 slash x', spec: `${S300}/x`, cached: true },
    ])('When git and tsgit remove the unmatched $label with cached $cached (row $id)', (row) => {
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
          row.spec,
        ]);
        const err = await caught(() => sut(ctx, [row.spec], { cached: row.cached }));

        // Assert
        expect(gitRun.exitCode).toBe(GIT_EXIT_FATAL);
        expect(err.data).toEqual(pathspecNoMatch(row.spec).data);
        expect(snapshotOf(tsgitRepo)).toEqual(snapshotOf(gitRepo));
      });
    });

    describe.each([
      { id: 'C8', label: 'P5000', spec: P5000, source: undefined },
      { id: 'C8', label: 'P5000', spec: P5000, source: 'HEAD' },
      { id: 'C8', label: 'S300', spec: S300, source: undefined },
      { id: 'C8', label: 'S300', spec: S300, source: 'HEAD' },
      { id: 'C8', label: 'S300 glob', spec: `${S300}*`, source: undefined },
      { id: 'C8', label: 'S300 slash x', spec: `${S300}/x`, source: undefined },
    ])('When git and tsgit restore the unmatched $label from $source (row $id)', (row) => {
      it('Then both refuse it as matching nothing', async () => {
        // Arrange
        const { gitRepo, tsgitRepo, ctx } = await twins([]);
        const sut = checkout;
        const gitSource = row.source === undefined ? [] : [row.source];

        // Act
        const gitRun = tryRunGitWithExit(['-C', gitRepo, 'checkout', ...gitSource, '--', row.spec]);
        const err = await caught(() =>
          sut(ctx, {
            paths: [row.spec],
            ...(row.source === undefined ? {} : { source: row.source }),
          }),
        );

        // Assert
        expect(gitRun.exitCode).toBe(GIT_EXIT_ERROR);
        expect(err.data).toEqual(pathspecNoMatch(row.spec).data);
        expect(snapshotOf(tsgitRepo)).toEqual(snapshotOf(gitRepo));
      });
    });

    describe.each([
      { id: 'C9', label: 'P5000', spec: P5000, head: false },
      { id: 'C9', label: 'S300', spec: S300, head: false },
      { id: 'C9', label: 'S300 glob', spec: `${S300}*`, head: false },
      { id: 'C9', label: 'S300 slash x', spec: `${S300}/x`, head: false },
      { id: 'C9', label: 'S300 from HEAD', spec: S300, head: true },
    ])('When git and tsgit grep the unmatched $label (row $id)', (row) => {
      it('Then neither reports a hit', async () => {
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
          'needle',
          ...gitRev,
          '--',
          row.spec,
        ]);

        // Assert
        expect(gitRun.exitCode).toBe(GIT_EXIT_ERROR);
        expect(result.paths).toEqual([]);
      });
    });

    describe('When git and tsgit add a path under a missing parent holding S300 (row C2)', () => {
      it('Then both refuse it as matching nothing', async () => {
        // Arrange
        const { gitRepo, tsgitRepo, ctx } = await twins([]);
        const spec = `sub/${S300}`;
        const sut = add;

        // Act
        const gitRun = tryRunGitWithExit(['-C', gitRepo, 'add', '--', spec]);
        const err = await caught(() => sut(ctx, [spec]));

        // Assert
        expect(gitRun.exitCode).toBe(GIT_EXIT_FATAL);
        expect(err.data).toEqual(pathspecNoMatch(spec).data);
        expect(snapshotOf(tsgitRepo)).toEqual(snapshotOf(gitRepo));
      });
    });

    describe('When git and tsgit add the dot excluding S300 (row C5)', () => {
      it('Then both stage the modified file and leave the same index', async () => {
        // Arrange
        const { gitRepo, tsgitRepo, ctx } = await twins([BASE]);
        const specs = ['.', `!${S300}`];
        const sut = add;

        // Act
        runGit(['-C', gitRepo, 'add', '--', ...specs.map(gitSpec)]);
        await sut(ctx, specs);

        // Assert
        expect(snapshotOf(tsgitRepo)).toEqual(snapshotOf(gitRepo));
        expect(runGit(['-C', tsgitRepo, 'status', '--porcelain'])).toBe('M  base\n');
      });
    });

    describe.each([
      { label: 'S256', spec: 's'.repeat(256) },
      { label: 'S300', spec: S300 },
      { label: 'S300 glob', spec: `${S300}*` },
      { label: 'S255 wildcard', spec: `?${S255}` },
      { label: 'P5000', spec: P5000 },
      { label: 'P5000 glob', spec: `${P5000}/*` },
      { label: 'S300 slash x', spec: `${S300}/x` },
    ])('When git and tsgit add the unmatched $label (rows C1, C3)', (row) => {
      it('Then both refuse it as matching nothing', async () => {
        // Arrange
        const { gitRepo, tsgitRepo, ctx } = await twins([]);
        const sut = add;

        // Act
        const gitRun = tryRunGitWithExit(['-C', gitRepo, 'add', '--', row.spec]);
        const err = await caught(() => sut(ctx, [row.spec]));

        // Assert
        expect(gitRun.exitCode).toBe(GIT_EXIT_FATAL);
        expect(err.data).toEqual(pathspecNoMatch(row.spec).data);
        expect(snapshotOf(tsgitRepo)).toEqual(snapshotOf(gitRepo));
      });
    });

    describe('When git and tsgit add a modified file together with S300 (row C4)', () => {
      it('Then both refuse S300 alone and stage nothing', async () => {
        // Arrange
        const { gitRepo, tsgitRepo, ctx } = await twins([BASE]);
        const sut = add;

        // Act
        const gitRun = tryRunGitWithExit(['-C', gitRepo, 'add', '--', BASE, S300]);
        const err = await caught(() => sut(ctx, [BASE, S300]));

        // Assert
        expect(gitRun.exitCode).toBe(GIT_EXIT_FATAL);
        expect(err.data).toEqual(pathspecNoMatch(S300).data);
        expect(runGit(['-C', tsgitRepo, 'status', '--porcelain'])).toBe(' M base\n');
        expect(snapshotOf(tsgitRepo)).toEqual(snapshotOf(gitRepo));
      });
    });

    describe('When git and tsgit add the dot excluding S300 slash x (row C6)', () => {
      it('Then both stage the modified file and leave the same index', async () => {
        // Arrange
        const { gitRepo, tsgitRepo, ctx } = await twins([BASE]);
        const specs = ['.', `!${S300}/x`];
        const sut = add;

        // Act
        runGit(['-C', gitRepo, 'add', '--', ...specs.map(gitSpec)]);
        await sut(ctx, specs);

        // Assert
        expect(snapshotOf(tsgitRepo)).toEqual(snapshotOf(gitRepo));
        expect(runGit(['-C', tsgitRepo, 'status', '--porcelain'])).toBe('M  base\n');
      });
    });

    const plantIndexOnly = (repos: ReadonlyArray<string>, name: string): void => {
      for (const repo of repos) {
        const blob = runGit(['-C', repo, 'rev-parse', `HEAD:${BASE}`]).trim();
        runGit(['-C', repo, 'update-index', '--add', '--cacheinfo', `100644,${blob},${name}`]);
      }
    };

    describe('When git and tsgit remove S300 planted only in the index (row I1)', () => {
      it('Then both drop it from the index', async () => {
        // Arrange
        const { gitRepo, tsgitRepo, ctx } = await twins([]);
        plantIndexOnly([gitRepo, tsgitRepo], S300);
        const sut = rm;

        // Act
        runGit(['-C', gitRepo, 'rm', '-q', '--cached', '--', S300]);
        await sut(ctx, [S300], { cached: true });

        // Assert
        expect(snapshotOf(tsgitRepo)).toEqual(snapshotOf(gitRepo));
        expect(runGit(['-C', tsgitRepo, 'ls-files']).split('\n')).not.toContain(S300);
      });
    });

    describe('When git and tsgit remove a pattern reaching S255 and an index-only S300 (row I4)', () => {
      it('Then both remove the two from the index', async () => {
        // Arrange
        const { gitRepo, tsgitRepo, ctx } = await twins([]);
        plantIndexOnly([gitRepo, tsgitRepo], S300);
        const spec = `${'s'.repeat(254)}*`;
        const sut = rm;

        // Act
        runGit(['-C', gitRepo, 'rm', '-q', '--cached', '--', spec]);
        await sut(ctx, [spec], { cached: true });

        // Assert
        expect(snapshotOf(tsgitRepo)).toEqual(snapshotOf(gitRepo));
        const left = runGit(['-C', tsgitRepo, 'ls-files']).split('\n');
        expect(left).not.toContain(S255);
        expect(left).not.toContain(S300);
      });
    });

    describe('When git and tsgit grep the index for an index-only S300 (row I3)', () => {
      it('Then both report the one hit', async () => {
        // Arrange
        const { gitRepo, tsgitRepo, ctx } = await twins([]);
        plantIndexOnly([gitRepo, tsgitRepo], S300);
        const sut = grep;

        // Act
        const result = await sut(ctx, {
          patterns: [/./],
          paths: [S300],
          target: 'index',
        });
        const gitRun = tryRunGitWithExit([
          '-C',
          gitRepo,
          'grep',
          '--cached',
          '-l',
          '-z',
          '.',
          '--',
          S300,
        ]);

        // Assert
        const gitHits = gitRun.stdout.split('\0').filter((name) => name !== '');
        expect(gitHits).toEqual([S300]);
        expect(result.paths[0]?.path).toBe(S300);
        expect(result.paths).toHaveLength(1);
        expect(snapshotOf(tsgitRepo)).toEqual(snapshotOf(gitRepo));
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

    describe.each([
      { id: 'K1', specs: [CJK100], modified: [], tracked: [], untracked: [CJK100] },
      { id: 'K1', specs: [CJK100], modified: [CJK100], tracked: [CJK100], untracked: [] },
      { id: 'K1', specs: ['.'], modified: [BASE], tracked: [], untracked: [CJK100] },
    ])('When git and tsgit add $specs on a host holding a wide name (row $id)', (row) => {
      it.runIf(canHoldWideComponent)('Then both leave the same index and status', async () => {
        // Arrange
        const { gitRepo, tsgitRepo, ctx } = await twins(row.modified, row.untracked, row.tracked);
        const sut = add;

        // Act
        runGit(['-C', gitRepo, 'add', '--', ...row.specs]);
        await sut(ctx, row.specs);

        // Assert
        expect(snapshotOf(tsgitRepo)).toEqual(snapshotOf(gitRepo));
        expect(runGit(['-C', tsgitRepo, 'ls-files', '-z']).split('\0')).toContain(CJK100);
      });
    });

    describe.each([{ cached: false }, { cached: true }])(
      'When git and tsgit remove a wide name with cached $cached (row K2)',
      (row) => {
        it.runIf(canHoldWideComponent)('Then both leave the same index and tree', async () => {
          // Arrange
          const { gitRepo, tsgitRepo, ctx } = await twins([], [], [CJK100]);
          const sut = rm;

          // Act
          runGit(['-C', gitRepo, 'rm', '-q', ...(row.cached ? ['--cached'] : []), '--', CJK100]);
          await sut(ctx, [CJK100], { cached: row.cached });

          // Assert
          expect(snapshotOf(tsgitRepo)).toEqual(snapshotOf(gitRepo));
          expect(await filesOf(tsgitRepo)).toEqual(await filesOf(gitRepo));
        });
      },
    );

    describe.each([
      { from: CJK100, to: 'short', tracked: [CJK100] },
      { from: BASE, to: CJK100, tracked: [] },
    ])('When git and tsgit move a path to or from a wide name (row K3)', (row) => {
      it.runIf(canHoldWideComponent)('Then both leave the same index and tree', async () => {
        // Arrange
        const { gitRepo, tsgitRepo, ctx } = await twins([], [], row.tracked);
        const sut = mv;

        // Act
        runGit(['-C', gitRepo, 'mv', '--', row.from, row.to]);
        await sut(ctx, [row.from], row.to);

        // Assert
        expect(snapshotOf(tsgitRepo)).toEqual(snapshotOf(gitRepo));
        expect(await filesOf(tsgitRepo)).toEqual(await filesOf(gitRepo));
      });
    });

    describe('When git and tsgit restore a modified wide name (row K4)', () => {
      it.runIf(canHoldWideComponent)('Then both restore the same content', async () => {
        // Arrange
        const { gitRepo, tsgitRepo, ctx } = await twins([CJK100], [], [CJK100]);
        const sut = checkout;

        // Act
        runGit(['-C', gitRepo, 'checkout', '--', CJK100]);
        await sut(ctx, { paths: [CJK100] });

        // Assert
        expect(await readFile(path.join(tsgitRepo, CJK100), 'utf8')).toBe(
          await readFile(path.join(gitRepo, CJK100), 'utf8'),
        );
        expect(snapshotOf(tsgitRepo)).toEqual(snapshotOf(gitRepo));
      });
    });

    describe.each([
      { state: 'untracked', modified: [], tracked: [], untracked: [CJK100] },
      { state: 'modified', modified: [CJK100], tracked: [CJK100], untracked: [] },
    ])('When git and tsgit report a $state wide name (row K5)', (row) => {
      it.runIf(canHoldWideComponent)('Then both list the same paths', async () => {
        // Arrange
        const { gitRepo, ctx } = await twins(row.modified, row.untracked, row.tracked);
        const sut = status;

        // Act
        const result = await sut(ctx);
        const gitRun = runGit([
          '-C',
          gitRepo,
          'status',
          '--porcelain',
          '-z',
          '--untracked-files=all',
        ]);

        // Assert
        const gitPaths = gitRun
          .split('\0')
          .filter((entry) => entry !== '')
          .map((entry) => entry.slice('XY '.length))
          .sort();
        const paths = [...result.untracked, ...result.changes.map((change) => change.path)].sort();
        expect(paths).toEqual(gitPaths);
        expect(paths).toContain(CJK100);
      });
    });

    describe('When git and tsgit grep a wide name (row K5)', () => {
      it.runIf(canHoldWideComponent)('Then both report the one hit', async () => {
        // Arrange
        const { gitRepo, ctx } = await twins([], [], [CJK100]);
        const sut = grep;

        // Act
        const result = await sut(ctx, { patterns: [/needle/], paths: [CJK100] });
        const gitRun = tryRunGitWithExit([
          '-C',
          gitRepo,
          'grep',
          '-l',
          '-z',
          'needle',
          '--',
          CJK100,
        ]);

        // Assert
        const gitHits = gitRun.stdout.split('\0').filter((name) => name !== '');
        expect(result.paths.map((entry) => entry.path)).toEqual(gitHits);
        expect(gitHits).toEqual([CJK100]);
      });
    });

    describe('When git and tsgit blame a wide name with one line appended (row K5)', () => {
      it.runIf(canHoldWideComponent)('Then both attribute the same lines', async () => {
        // Arrange
        const { gitRepo, tsgitRepo, ctx } = await twins([], [], [CJK100]);
        for (const repo of [gitRepo, tsgitRepo]) {
          await writeFile(path.join(repo, CJK100), 'needle\nchanged\n');
        }
        const sut = blame;
        const zeros = '0'.repeat(40);

        // Act
        const result = await sut(ctx, CJK100, { worktree: true });
        const gitRun = runGit(['-C', gitRepo, 'blame', '--root', '-l', '-s', '--', CJK100]);

        // Assert
        const gitLines = gitRun
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => line.slice(0, 40));
        expect(result.lines.map((line) => (line.committed ? line.commit : zeros))).toEqual(
          gitLines,
        );
        expect(gitLines).toHaveLength(2);
      });
    });

    describe('When git and tsgit act on a wide name no host can create (row L3)', () => {
      it.skipIf(canHoldWideComponent)('Then add, rm, checkout and grep find no match', async () => {
        // Arrange
        const { gitRepo, tsgitRepo, ctx } = await twins([]);

        // Act
        const gitAdd = tryRunGitWithExit(['-C', gitRepo, 'add', '--', CJK100]);
        const addErr = await caught(() => add(ctx, [CJK100]));
        const gitRm = tryRunGitWithExit(['-C', gitRepo, 'rm', '--', CJK100]);
        const rmErr = await caught(() => rm(ctx, [CJK100]));
        const gitCheckout = tryRunGitWithExit(['-C', gitRepo, 'checkout', '--', CJK100]);
        const checkoutErr = await caught(() => checkout(ctx, { paths: [CJK100] }));
        const gitGrep = tryRunGitWithExit(['-C', gitRepo, 'grep', '-l', 'needle', '--', CJK100]);
        const grepResult = await grep(ctx, { patterns: [/needle/], paths: [CJK100] });

        // Assert
        expect(gitAdd.exitCode).toBe(GIT_EXIT_FATAL);
        expect(addErr.data).toEqual(pathspecNoMatch(CJK100).data);
        expect(gitRm.exitCode).toBe(GIT_EXIT_FATAL);
        expect(rmErr.data).toEqual(pathspecNoMatch(CJK100).data);
        expect(gitCheckout.exitCode).toBe(GIT_EXIT_ERROR);
        expect(checkoutErr.data).toEqual(pathspecNoMatch(CJK100).data);
        expect(gitGrep.exitCode).toBe(GIT_EXIT_ERROR);
        expect(grepResult.paths).toEqual([]);
        expect(snapshotOf(tsgitRepo)).toEqual(snapshotOf(gitRepo));
      });
    });

    describe('When git and tsgit grep a tree holding a wide name without a pathspec (row K6)', () => {
      it.runIf(canHoldWideComponent)('Then both report the same hits', async () => {
        // Arrange
        const { gitRepo, ctx } = await twins([], [], [CJK100]);
        const sut = grep;

        // Act
        const result = await sut(ctx, { patterns: [/needle/] });
        const gitRun = tryRunGitWithExit(['-C', gitRepo, 'grep', '-l', '-z', 'needle']);

        // Assert
        const gitHits = gitRun.stdout.split('\0').filter((name) => name !== '');
        expect(result.paths.map((entry) => entry.path).sort()).toEqual([...gitHits].sort());
        expect(gitHits).toContain(CJK100);
      });
    });

    describe('When git and tsgit switch to and from a commit holding a wide name (row K6)', () => {
      it.runIf(canHoldWideComponent)('Then both leave the same index and tree', async () => {
        // Arrange
        const { gitRepo, tsgitRepo, ctx } = await twins([]);
        for (const repo of [gitRepo, tsgitRepo]) {
          runGit(['-C', repo, 'checkout', '-q', '-b', 'wide']);
          await writeAt(repo, CJK100, 'needle\n');
          runGit(['-C', repo, 'add', '--', CJK100]);
          runGit(
            [
              '-C',
              repo,
              '-c',
              'user.name=t',
              '-c',
              'user.email=t@example.com',
              'commit',
              '-q',
              '-m',
              'w',
            ],
            { env: runGitEnv() },
          );
          runGit(['-C', repo, 'checkout', '-q', 'main']);
        }
        const sut = checkout;

        // Act
        runGit(['-C', gitRepo, 'checkout', '-q', 'wide']);
        await sut(ctx, { rev: 'wide' });
        const onWide = { tsgit: snapshotOf(tsgitRepo), git: snapshotOf(gitRepo) };
        const wideFiles = { tsgit: await filesOf(tsgitRepo), git: await filesOf(gitRepo) };
        runGit(['-C', gitRepo, 'checkout', '-q', 'main']);
        await sut(ctx, { rev: 'main' });

        // Assert
        expect(onWide.tsgit).toEqual(onWide.git);
        expect(wideFiles.tsgit).toEqual(wideFiles.git);
        expect(wideFiles.tsgit).toContain(CJK100);
        expect(snapshotOf(tsgitRepo)).toEqual(snapshotOf(gitRepo));
        expect(await filesOf(tsgitRepo)).toEqual(await filesOf(gitRepo));
      });
    });
  },
);
