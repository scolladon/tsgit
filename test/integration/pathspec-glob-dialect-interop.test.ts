/**
 * Cross-tool interop — pathspec wildcards follow git's `wildmatch` (flags 0)
 * over the path's bytes: `*` and `?` cross `/`, `[...]` is a bracket
 * expression, a body names itself and its descendants verbatim first, and an
 * unanchored `foo*` matches the root only. `add`, `grep`, `checkout` and `rm`
 * select the same paths as `git`, and an index path that is not UTF-8 is
 * matched by its raw bytes.
 *
 * @proves
 *   surface:        add, rm, checkout, grep
 *   bucket:         cross-tool-interop
 *   unique:         pathspec wildcards select paths as git's wildmatch does
 *   interopSurface: add, rm, checkout, grep
 */
import { mkdir, mkdtemp, readFile, realpath, rm as removeTree, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/index.js';
import { add } from '../../src/application/commands/add.js';
import { checkout } from '../../src/application/commands/checkout.js';
import { grep } from '../../src/application/commands/grep.js';
import { rm } from '../../src/application/commands/rm.js';
import { readIndex } from '../../src/application/primitives/read-index.js';
import { encode } from '../../src/domain/objects/encoding.js';
import { compilePathspec } from '../../src/domain/pathspec/compile-pathspec.js';
import { matchesIndexPath } from '../../src/domain/pathspec/matching-path.js';
import {
  GIT_AVAILABLE,
  hashBlob,
  hex,
  lsFilesPathHex,
  pathHexOfRecords,
  runGit,
  runGitBytes,
  runGitEnv,
  stageRaw,
  tryRunGitWithExit,
} from './interop-helpers.js';

const REGULAR_MODE = '100644';
const PINNED_DATE = '@1700000000 +0000';
const LOSSY = Uint8Array.of(0x61, 0xff);
const E_ACUTE = Uint8Array.of(0x61, 0xc3, 0xa9);

type Files = Readonly<Record<string, string>>;

const splitNames = (nul: string): string[] => nul.split('\0').filter((name) => name !== '');

const namesOf = (repo: string): string[] =>
  splitNames(runGit(['-C', repo, 'ls-files', '-z'])).sort();

const snapshotOf = (repo: string) => ({
  index: runGit(['-C', repo, 'ls-files', '-s']),
  status: runGit(['-C', repo, 'status', '--porcelain', '--untracked-files=all']),
});

describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')(
  'Given pathspec wildcards over named files',
  () => {
    let root = '';
    let counter = 0;

    beforeAll(async () => {
      root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-glob-dialect-')));
    });

    afterAll(async () => {
      await removeTree(root, { recursive: true, force: true });
    });

    const writeFiles = async (repo: string, files: Files, content?: string): Promise<void> => {
      for (const [name, body] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(repo, name)), { recursive: true });
        await writeFile(path.join(repo, name), content ?? body);
      }
    };

    const commitAll = (repo: string): void => {
      runGit(['-C', repo, 'add', '-A']);
      runGit(['-C', repo, '-c', 'user.name=A', '-c', 'user.email=a@a', 'commit', '-qm', 'c'], {
        env: {
          ...runGitEnv(),
          GIT_AUTHOR_DATE: PINNED_DATE,
          GIT_COMMITTER_DATE: PINNED_DATE,
        },
      });
    };

    const twin = async (
      side: 'git' | 'tsgit',
      files: Files,
      options: { tracked: boolean; dirty?: boolean },
    ): Promise<string> => {
      counter += 1;
      const repo = path.join(root, `${side}-${counter}`);
      runGit(['init', '-q', '-b', 'main', repo]);
      await writeFiles(repo, files);
      if (options.tracked) commitAll(repo);
      if (options.dirty === true) await writeFiles(repo, files, 'changed\n');
      return repo;
    };

    const twins = async (files: Files, options: { tracked: boolean; dirty?: boolean }) => ({
      gitRepo: await twin('git', files, options),
      tsgitRepo: await twin('tsgit', files, options),
    });

    describe.each([
      {
        files: ['a/b/c.txt', 'top.txt', 'other.md'],
        spec: '*.txt',
        staged: ['a/b/c.txt', 'top.txt'],
      },
      {
        files: ['src/a/b.ts', 'src/x.ts', 'y.ts'],
        spec: 'src/*.ts',
        staged: ['src/a/b.ts', 'src/x.ts'],
      },
      { files: ['dir/foobar', 'foo1', 'keep'], spec: 'foo*', staged: ['foo1'] },
      { files: ['a/x', 'bx', 'x'], spec: '?x', staged: ['bx'] },
      {
        files: ['a.txt', 'b.txt', 'd.txt', '1.txt'],
        spec: '[a-c].txt',
        staged: ['a.txt', 'b.txt'],
      },
      {
        files: ['a.txt', 'b.txt', 'd.txt', '1.txt'],
        spec: '[!a].txt',
        staged: ['1.txt', 'b.txt', 'd.txt'],
      },
      {
        files: ['a.txt', 'b.txt', 'd.txt', '1.txt'],
        spec: '[^a].txt',
        staged: ['1.txt', 'b.txt', 'd.txt'],
      },
      {
        files: ['a.txt', 'b.txt', 'd.txt', '1.txt'],
        spec: '[[:digit:]].txt',
        staged: ['1.txt'],
      },
      { files: ['a/b', 'x'], spec: '[/a]*', staged: ['a/b'] },
      { files: ['a[', 'ab'], spec: 'a[', staged: ['a['] },
      { files: ['a?/f', 'ab'], spec: 'a?', staged: ['a?/f', 'ab'] },
      { files: ['é.txt', 'a.txt'], spec: '?.txt', staged: ['a.txt'] },
      { files: ['é.txt', 'a.txt'], spec: '??.txt', staged: ['é.txt'] },
      { files: ['x.txt', 'd/x.txt'], spec: '**/x.txt', staged: ['d/x.txt'] },
      { files: ['a/b/c', 'a/d'], spec: 'a/**', staged: ['a/b/c', 'a/d'] },
      { files: ['d/a.txt', 'e.txt'], spec: 'd/*', staged: ['d/a.txt'] },
      { files: ['a', ']', 'b'], spec: '[]a]', staged: [']', 'a'] },
      { files: ['a[b', 'ab'], spec: 'a[b', staged: ['a[b'] },
    ])(
      'When git and tsgit add the untracked files with the pathspec $spec',
      ({ files, spec, staged }) => {
        it('Then both stage the same paths', async () => {
          // Arrange
          const named = Object.fromEntries(files.map((name) => [name, `${name}\n`]));
          const { gitRepo, tsgitRepo } = await twins(named, { tracked: false });
          const sut = add;

          // Act
          runGit(['-C', gitRepo, 'add', '--', spec]);
          await sut(createNodeContext({ workDir: tsgitRepo }), [spec]);

          // Assert
          expect(namesOf(gitRepo)).toEqual(staged);
          expect(snapshotOf(tsgitRepo)).toEqual(snapshotOf(gitRepo));
        });
      },
    );

    describe.each([
      { files: ['a?/f', 'ab'], pattern: '.', spec: ['a?'], listed: ['a?/f', 'ab'] },
      { files: ['dir/foobar', 'foo1'], pattern: 'o', spec: ['foo*'], listed: ['foo1'] },
      { files: ['a.txt'], pattern: 'a', spec: ['nomatch*'], listed: [] },
      {
        files: ['a/b/c.txt', 'top.txt'],
        pattern: 'txt',
        spec: ['*.txt'],
        listed: ['a/b/c.txt', 'top.txt'],
      },
      { files: ['a.txt'], pattern: 'a', spec: ['nomatch*', 'a.txt'], listed: ['a.txt'] },
      { files: ['a.txt'], pattern: 'a', spec: ['missing'], listed: [] },
    ])(
      'When git and tsgit grep for $pattern with the pathspec $spec',
      ({ files, pattern, spec, listed }) => {
        it('Then both list the same files', async () => {
          // Arrange
          const named = Object.fromEntries(files.map((name) => [name, `${name}\n`]));
          const { gitRepo, tsgitRepo } = await twins(named, { tracked: true });
          const sut = grep;

          // Act
          const expected = splitNames(
            tryRunGitWithExit(['-C', gitRepo, 'grep', '-lz', pattern, '--', ...spec]).stdout,
          ).sort();
          const result = await sut(createNodeContext({ workDir: tsgitRepo }), {
            patterns: [new RegExp(pattern)],
            paths: spec,
          });

          // Assert
          expect(expected).toEqual(listed);
          expect(result.paths.map((hit) => hit.path).sort()).toEqual(expected);
        });
      },
    );

    describe.each([
      { files: ['a?/f'], spec: 'a?', status: '' },
      { files: ['dir/foobar', 'foo1'], spec: 'foo*', status: ' M dir/foobar\n' },
    ])(
      'When git and tsgit restore dirty files with the pathspec $spec',
      ({ files, spec, status }) => {
        it('Then both restore the same files', async () => {
          // Arrange
          const named = Object.fromEntries(files.map((name) => [name, `${name}\n`]));
          const options = { tracked: true, dirty: true };
          const { gitRepo, tsgitRepo } = await twins(named, options);
          const sut = checkout;

          // Act
          runGit(['-C', gitRepo, 'checkout', '--', spec]);
          await sut(createNodeContext({ workDir: tsgitRepo }), { paths: [spec] });

          // Assert
          expect(snapshotOf(gitRepo).status).toBe(status);
          expect(snapshotOf(tsgitRepo)).toEqual(snapshotOf(gitRepo));
          expect(await readFile(path.join(tsgitRepo, files[0] as string), 'utf8')).toBe(
            await readFile(path.join(gitRepo, files[0] as string), 'utf8'),
          );
        });
      },
    );

    describe.each([
      { files: ['dir/foobar', 'foo1'], spec: 'foo*', recursive: false, remaining: ['dir/foobar'] },
      {
        files: ['a/b/c.txt', 'top.txt', 'k.md'],
        spec: '*.txt',
        recursive: false,
        remaining: ['k.md'],
      },
      { files: ['a?/f', 'ab'], spec: 'a?', recursive: false, remaining: [] },
      { files: ['a?/f', 'ab'], spec: 'a?', recursive: true, remaining: [] },
      { files: ['dir/f'], spec: 'd*', recursive: false, remaining: [] },
    ])(
      'When git and tsgit remove tracked files with the pathspec $spec',
      ({ files, spec, recursive, remaining }) => {
        it('Then both leave the same index and tree', async () => {
          // Arrange
          const named = Object.fromEntries(files.map((name) => [name, `${name}\n`]));
          const { gitRepo, tsgitRepo } = await twins(named, { tracked: true });
          const sut = rm;

          // Act
          runGit(['-C', gitRepo, 'rm', '-q', ...(recursive ? ['-r'] : []), '--', spec]);
          await sut(createNodeContext({ workDir: tsgitRepo }), [spec], { recursive });

          // Assert
          expect(namesOf(gitRepo)).toEqual(remaining);
          expect(snapshotOf(tsgitRepo)).toEqual(snapshotOf(gitRepo));
        });
      },
    );
  },
);

describe.skipIf(!GIT_AVAILABLE)('Given an index holding a non-UTF-8 path', () => {
  let root = '';
  let counter = 0;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-glob-bytes-')));
  });

  afterAll(async () => {
    await removeTree(root, { recursive: true, force: true });
  });

  const indexed = (side: string): string => {
    counter += 1;
    const repo = path.join(root, `${side}-${counter}`);
    runGit(['init', '-q', '-b', 'main', repo]);
    const blob = hashBlob(repo, 'x\n');
    stageRaw(repo, [
      { mode: REGULAR_MODE, oid: blob, path: encode('ab') },
      { mode: REGULAR_MODE, oid: blob, path: E_ACUTE },
      { mode: REGULAR_MODE, oid: blob, path: LOSSY },
    ]);
    return repo;
  };

  const AB = '6162';
  const E_ACUTE_HEX = '61c3a9';
  const LOSSY_HEX = '61ff';

  describe.each([
    { spec: 'a?', selected: [AB, LOSSY_HEX] },
    { spec: 'a??', selected: [E_ACUTE_HEX] },
    { spec: 'a[^b]', selected: [LOSSY_HEX] },
    { spec: 'a*', selected: [AB, E_ACUTE_HEX, LOSSY_HEX] },
    { spec: 'a[[:alpha:]]', selected: [AB] },
  ])('When git and tsgit select index paths with the pathspec $spec', ({ spec, selected }) => {
    it('Then both select the same raw paths', async () => {
      // Arrange
      const repo = indexed('select');
      const sut = compilePathspec;

      // Act
      const pathspec = sut([spec]);
      const index = await readIndex(createNodeContext({ workDir: repo }));
      const result = index.entries
        .filter((entry) => matchesIndexPath(pathspec, entry))
        .map((entry) => hex(entry.pathBytes ?? encode(entry.path)));

      // Assert
      const expected = pathHexOfRecords(
        runGitBytes(['-C', repo, 'ls-files', '-s', '-z', '--', spec]),
      );
      expect(expected).toEqual(selected);
      expect(result).toEqual(expected);
    });
  });

  describe('When git and tsgit remove the pathspec a? from the index only', () => {
    it('Then both keep the same entries', async () => {
      // Arrange
      const gitRepo = indexed('git-rm');
      const tsgitRepo = indexed('tsgit-rm');
      const sut = rm;

      // Act
      const git = tryRunGitWithExit(['-C', gitRepo, 'rm', '--cached', '-q', 'a?']);
      await sut(createNodeContext({ workDir: tsgitRepo }), ['a?'], { cached: true });

      // Assert
      expect(git.exitCode).toBe(0);
      expect(lsFilesPathHex(gitRepo)).toEqual([E_ACUTE_HEX]);
      expect(lsFilesPathHex(tsgitRepo)).toEqual(lsFilesPathHex(gitRepo));
    });
  });
});

describe.skipIf(!GIT_AVAILABLE || process.platform !== 'linux')(
  'Given untracked files whose names are not UTF-8',
  () => {
    let root = '';

    beforeAll(async () => {
      root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-glob-lossy-')));
    });

    afterAll(async () => {
      await removeTree(root, { recursive: true, force: true });
    });

    const populated = async (side: string): Promise<string> => {
      const repo = path.join(root, side);
      runGit(['init', '-q', '-b', 'main', repo]);
      const base = Buffer.from(`${repo}/`);
      for (const name of [LOSSY, E_ACUTE, encode('ab')]) {
        await writeFile(Buffer.concat([base, name]), 'x\n');
      }
      return repo;
    };

    describe('When git and tsgit add the pathspec a?', () => {
      it('Then both stage the raw names that are one byte longer than a', async () => {
        // Arrange
        const gitRepo = await populated('git');
        const tsgitRepo = await populated('tsgit');
        const sut = add;

        // Act
        runGit(['-C', gitRepo, 'add', '--', 'a?']);
        await sut(createNodeContext({ workDir: tsgitRepo }), ['a?']);

        // Assert
        expect(lsFilesPathHex(gitRepo)).toEqual(['6162', '61ff']);
        expect(lsFilesPathHex(tsgitRepo)).toEqual(lsFilesPathHex(gitRepo));
      });
    });
  },
);
