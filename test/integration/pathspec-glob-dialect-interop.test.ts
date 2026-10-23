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
import { readIndex } from '../../src/application/primitives/read-index.js';
import { pathspecNoMatch } from '../../src/domain/commands/error.js';
import { TsgitError } from '../../src/domain/error.js';
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
      it('Then git stages both raw names and tsgit, whose string-pathed filesystem cannot reach a non-UTF-8 name, stages only ab', async () => {
        // Arrange
        const gitRepo = await populated('git');
        const tsgitRepo = await populated('tsgit');
        const sut = add;

        // Act
        runGit(['-C', gitRepo, 'add', '--', 'a?']);
        await sut(createNodeContext({ workDir: tsgitRepo }), ['a?']);

        // Assert
        expect(lsFilesPathHex(gitRepo)).toEqual(['6162', '61ff']);
        expect(lsFilesPathHex(tsgitRepo)).toEqual(['6162']);
      });
    });
  },
);

describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')(
  'Given rm pathspecs that match nothing or only a directory',
  () => {
    let root = '';
    let counter = 0;

    beforeAll(async () => {
      root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-glob-rm-')));
    });

    afterAll(async () => {
      await removeTree(root, { recursive: true, force: true });
    });

    const tracked = async (side: string, names: ReadonlyArray<string>): Promise<string> => {
      counter += 1;
      const repo = path.join(root, `${side}-${counter}`);
      runGit(['init', '-q', '-b', 'main', repo]);
      for (const name of names) {
        await mkdir(path.dirname(path.join(repo, name)), { recursive: true });
        await writeFile(path.join(repo, name), `${name}\n`);
      }
      runGit(['-C', repo, 'add', '-A']);
      return repo;
    };

    const refusalOf = async (run: () => Promise<unknown>): Promise<unknown> => {
      try {
        await run();
      } catch (err) {
        if (err instanceof TsgitError) return err.data;
        throw err;
      }
      return undefined;
    };

    describe.each([
      { names: ['tracked.txt'], args: ['nomatch*', 'tracked.txt'], kept: 'tracked.txt' },
      {
        names: ['tracked.txt'],
        args: ['tracked.txt', 'nomatch*'],
        kept: 'tracked.txt',
      },
      { names: ['x.txt'], args: ['untr*'], kept: 'x.txt' },
      { names: ['a.txt'], args: ['n1*', 'n2*'], kept: 'a.txt' },
    ])('When git and tsgit rm the pathspecs $args', ({ names, args, kept }) => {
      it('Then both refuse as unmatched, keep the index and keep the file', async () => {
        // Arrange
        const gitRepo = await tracked('git', names);
        const tsgitRepo = await tracked('tsgit', names);
        const sut = rm;

        // Act
        const git = tryRunGitWithExit(['-C', gitRepo, 'rm', '-q', '--', ...args]);
        const refusal = await refusalOf(() => sut(createNodeContext({ workDir: tsgitRepo }), args));

        // Assert
        const pattern = args.find((arg) => arg.includes('*')) as string;
        expect(git.exitCode).toBe(128);
        expect(git.stderr).toContain(`pathspec '${pattern}' did not match any files`);
        expect(refusal).toEqual(pathspecNoMatch(pattern).data);
        expect(namesOf(tsgitRepo)).toEqual(namesOf(gitRepo));
        expect(await readFile(path.join(tsgitRepo, kept), 'utf8')).toBe(`${kept}\n`);
      });
    });

    describe.each([
      { args: ['a?'], flags: [] },
      { args: ['a?/'], flags: ['--cached'] },
    ])('When git and tsgit rm $flags $args beside a?/f and zz', ({ args, flags }) => {
      it('Then both refuse recursively without -r and keep the index', async () => {
        // Arrange
        const gitRepo = await tracked('git', ['a?/f', 'zz']);
        const tsgitRepo = await tracked('tsgit', ['a?/f', 'zz']);
        const sut = rm;
        const cached = flags.length > 0;
        const pattern = args[0] as string;

        // Act
        const git = tryRunGitWithExit(['-C', gitRepo, 'rm', '-q', ...flags, '--', ...args]);
        const refusal = await refusalOf(() =>
          sut(createNodeContext({ workDir: tsgitRepo }), [pattern], { cached }),
        );

        // Assert
        expect(git.exitCode).toBe(128);
        expect(git.stderr).toContain(`not removing '${pattern}' recursively without -r`);
        expect(refusal).toEqual({ code: 'RM_RECURSIVE_WITHOUT_R', pattern });
        expect(namesOf(tsgitRepo)).toEqual(namesOf(gitRepo));
      });
    });
  },
);

describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')(
  'Given add pathspecs that match nothing',
  () => {
    let root = '';
    let counter = 0;

    beforeAll(async () => {
      root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-glob-add-')));
    });

    afterAll(async () => {
      await removeTree(root, { recursive: true, force: true });
    });

    interface Row {
      readonly files: Files;
      readonly tracked?: boolean;
      readonly prepare?: (repo: string) => Promise<void>;
      readonly args: ReadonlyArray<string>;
      readonly renormalize?: boolean;
      /** The pathspec git names in its refusal; absent when git accepts. */
      readonly refused?: string;
    }

    const looseCountOf = async (repo: string): Promise<number> => {
      const prefixes = (await readdir(path.join(repo, '.git', 'objects'))).filter((name) =>
        /^[0-9a-f]{2}$/.test(name),
      );
      const counts = await Promise.all(
        prefixes.map(
          async (prefix) => (await readdir(path.join(repo, '.git', 'objects', prefix))).length,
        ),
      );
      return counts.reduce((sum, count) => sum + count, 0);
    };

    const built = async (side: string, spec: Row): Promise<string> => {
      counter += 1;
      const repo = path.join(root, `${side}-${counter}`);
      runGit(['init', '-q', '-b', 'main', repo]);
      for (const [name, body] of Object.entries(spec.files)) {
        await mkdir(path.dirname(path.join(repo, name)), { recursive: true });
        await writeFile(path.join(repo, name), body);
      }
      if (spec.tracked === true) {
        runGit(['-C', repo, 'add', '-A']);
        runGit(['-C', repo, '-c', 'user.name=A', '-c', 'user.email=a@a', 'commit', '-qm', 'c'], {
          env: { ...runGitEnv(), GIT_AUTHOR_DATE: PINNED_DATE, GIT_COMMITTER_DATE: PINNED_DATE },
        });
      }
      await spec.prepare?.(repo);
      return repo;
    };

    const refusalOf = async (run: () => Promise<unknown>): Promise<unknown> => {
      try {
        await run();
      } catch (err) {
        if (err instanceof TsgitError) return err.data;
        throw err;
      }
      return undefined;
    };

    const ignoring = (patterns: string): Files => ({ '.gitignore': patterns });
    const remove = (name: string) => (repo: string) => removeTree(path.join(repo, name));
    const overwrite = (name: string, body: string) => async (repo: string) => {
      await writeFile(path.join(repo, name), body);
    };

    /** git's `file_exists` escape: a literal naming an empty directory is not refused. */
    const emptyDirectory = (name: string) => (repo: string) => mkdir(path.join(repo, name));

    const rows: ReadonlyArray<Row> = [
      {
        files: { 'real.txt': 'r\n' },
        args: ['nomatch*', 'real.txt'],
        refused: 'nomatch*',
      },
      { files: { 'a.txt': 'a\n' }, args: ['a*', 'nomatch*'], refused: 'nomatch*' },
      { files: { 'a.txt': 'a\n' }, args: ['nomatch*', 'a*'], refused: 'nomatch*' },
      {
        files: { 'x.log': 'x\n', ...ignoring('*.log\n') },
        args: ['*.log'],
        refused: '*.log',
      },
      {
        files: { 'x.log': 'x\n', ...ignoring('*.log\n') },
        args: ['x*'],
        refused: 'x*',
      },
      {
        files: { 'd/x.log': 'x\n', 'd/y.txt': 'y\n', ...ignoring('*.log\n') },
        args: ['d/*.log'],
        refused: 'd/*.log',
      },
      {
        files: { 'x.log': 'x\n', 'real.txt': 'r\n', ...ignoring('*.log\n') },
        args: ['*.log', 'real.txt'],
        refused: '*.log',
      },
      {
        files: { 'x.log': 'x\n', 'real.txt': 'r\n', ...ignoring('*.log\n') },
        args: ['real.txt', '*.log', 'nomatch*'],
        refused: '*.log',
      },
      {
        files: { 'd/x.log': 'x\n', 'real.txt': 'r\n', ...ignoring('d/\n') },
        args: ['*.log'],
        refused: '*.log',
      },
      { files: { a: 'a\n' }, args: ['n1*', 'n2*'], refused: 'n1*' },
      { files: { a: 'a\n' }, args: ['n1*', 'missing'], refused: 'n1*' },
      { files: { a: 'a\n' }, args: ['missing', 'n1*'], refused: 'missing' },
      { files: { 'a.txt': 'a\n' }, args: ['.', 'nomatch*'], refused: 'nomatch*' },
      { files: { 'a.txt': 'a\n' }, args: ['zz*', '.'], refused: 'zz*' },
      { files: { 'dir/f': 'f\n', 'd.txt': 'd\n' }, args: ['d*/'], refused: 'd*/' },
      { files: { ab: 'ab\n' }, args: ['a[[:foo:]]'], refused: 'a[[:foo:]]' },
      { files: { 'dir/file': 'f\n' }, args: ['di?'], refused: 'di?' },
      {
        files: { 'nomatch*': 'n\n', ...ignoring('nomatch?\n') },
        args: ['nomatch*'],
      },
      { files: { 't.txt': 't\n' }, tracked: true, args: ['t*'] },
      {
        files: { 't.txt': 't\n', 'u.txt': 'u\n' },
        tracked: true,
        prepare: remove('t.txt'),
        args: ['t*'],
      },
      {
        files: { 'a.txt': 'a\n' },
        tracked: true,
        renormalize: true,
        args: ['nomatch*'],
        refused: 'nomatch*',
      },
      {
        files: { 'a.txt': 'a\n' },
        tracked: true,
        renormalize: true,
        args: ['a*', 'nomatch*'],
        refused: 'nomatch*',
      },
      { files: { 'a.txt': 'a\n' }, tracked: true, renormalize: true, args: ['a*'] },
      {
        files: { 'a.txt': 'a\n' },
        tracked: true,
        prepare: overwrite('nomatch*', 'n\n'),
        renormalize: true,
        args: ['nomatch*'],
      },
      {
        files: { 'a.txt': 'a\n' },
        tracked: true,
        prepare: overwrite('untracked.txt', 'u\n'),
        renormalize: true,
        args: ['untracked.txt'],
      },
      {
        files: { 'a.txt': 'a\n' },
        tracked: true,
        prepare: overwrite('untracked.txt', 'u\n'),
        renormalize: true,
        args: ['untr*'],
        refused: 'untr*',
      },
      { files: { k: 'k\n' }, prepare: emptyDirectory('e'), args: ['e'] },
      { files: { k: 'k\n' }, prepare: emptyDirectory('e'), args: ['e', 'k*'] },
    ];

    describe.each(rows)('When git and tsgit add $args', (spec) => {
      it('Then both agree on the verdict, the index and the loose objects', async () => {
        // Arrange
        const gitRepo = await built('git', spec);
        const tsgitRepo = await built('tsgit', spec);
        const flags = spec.renormalize === true ? ['--renormalize'] : [];
        const sut = add;

        // Act
        const git = tryRunGitWithExit(['-C', gitRepo, 'add', ...flags, '--', ...spec.args]);
        const refusal = await refusalOf(() =>
          sut(createNodeContext({ workDir: tsgitRepo }), [...spec.args], {
            renormalize: spec.renormalize === true,
          }),
        );

        // Assert
        if (spec.refused === undefined) {
          expect(git.exitCode).toBe(0);
          expect(refusal).toBeUndefined();
        } else {
          expect(git.exitCode).toBe(128);
          expect(refusal).toEqual(pathspecNoMatch(spec.refused).data);
          expect(git.stderr.trim()).toBe(
            `fatal: pathspec '${(refusal as { pattern: string }).pattern}' did not match any files`,
          );
        }
        expect(snapshotOf(tsgitRepo)).toEqual(snapshotOf(gitRepo));
        expect(await looseCountOf(tsgitRepo)).toBe(await looseCountOf(gitRepo));
      });
    });

    describe('When git and tsgit add nomatch* while index.lock exists', () => {
      it('Then both refuse on the lock, not on the pathspec', async () => {
        // Arrange
        const spec: Row = {
          files: { 'a.txt': 'a\n' },
          args: ['nomatch*'],
          prepare: overwrite(path.join('.git', 'index.lock'), ''),
        };
        const gitRepo = await built('git', spec);
        const tsgitRepo = await built('tsgit', spec);
        const sut = add;

        // Act
        const git = tryRunGitWithExit(['-C', gitRepo, 'add', '--', 'nomatch*']);
        const refusal = await refusalOf(() =>
          sut(createNodeContext({ workDir: tsgitRepo }), ['nomatch*']),
        );

        // Assert
        expect(git.exitCode).toBe(128);
        expect(git.stderr).toContain('index.lock');
        expect((refusal as { code: string }).code).toBe('RESOURCE_LOCKED');
        expect(await readFile(path.join(tsgitRepo, '.git', 'index.lock'), 'utf8')).toBe('');
      });
    });
  },
);

describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')(
  'Given checkout pathspecs against a tracked repository',
  () => {
    let root = '';
    let counter = 0;

    beforeAll(async () => {
      root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-glob-checkout-')));
    });

    afterAll(async () => {
      await removeTree(root, { recursive: true, force: true });
    });

    const unmatchedLine = (pattern: string): string =>
      `error: pathspec '${pattern}' did not match any file(s) known to git`;

    interface Setup {
      readonly files: Files;
      readonly dirty?: ReadonlyArray<string>;
      readonly staged?: ReadonlyArray<string>;
      readonly untracked?: ReadonlyArray<string>;
    }

    const built = async (side: string, setup: Setup): Promise<string> => {
      counter += 1;
      const repo = path.join(root, `${side}-${counter}`);
      runGit(['init', '-q', '-b', 'main', repo]);
      for (const [name, body] of Object.entries(setup.files)) {
        await mkdir(path.dirname(path.join(repo, name)), { recursive: true });
        await writeFile(path.join(repo, name), body);
      }
      commitAllIn(repo);
      for (const name of setup.dirty ?? []) await writeFile(path.join(repo, name), 'changed\n');
      for (const name of setup.staged ?? []) {
        await writeFile(path.join(repo, name), 'new\n');
        runGit(['-C', repo, 'add', '--', name]);
      }
      for (const name of setup.untracked ?? []) await writeFile(path.join(repo, name), 'u\n');
      return repo;
    };

    const commitAllIn = (repo: string): void => {
      runGit(['-C', repo, 'add', '-A']);
      runGit(['-C', repo, '-c', 'user.name=A', '-c', 'user.email=a@a', 'commit', '-qm', 'c'], {
        env: { ...runGitEnv(), GIT_AUTHOR_DATE: PINNED_DATE, GIT_COMMITTER_DATE: PINNED_DATE },
      });
    };

    const refusalOf = async (run: () => Promise<unknown>): Promise<unknown> => {
      try {
        await run();
      } catch (err) {
        if (err instanceof TsgitError) return err.data;
        throw err;
      }
      return undefined;
    };

    const dirtyFile: Setup = {
      files: { 'dirty.txt': 'd\n', 'dir/x': 'x\n' },
      dirty: ['dirty.txt'],
    };
    const plain: Setup = { files: { 'a.txt': 'a\n' } };

    describe.each([
      { setup: dirtyFile, args: ['nomatch*', 'dirty.txt'], unmatched: ['nomatch*'] },
      { setup: dirtyFile, args: ['d*', 'nomatch*'], unmatched: ['nomatch*'] },
      {
        setup: dirtyFile,
        source: 'HEAD',
        args: ['nomatch*', 'dirty.txt'],
        unmatched: ['nomatch*'],
      },
      { setup: plain, args: ['n1*', 'n2*'], unmatched: ['n1*', 'n2*'] },
      { setup: plain, args: ['n1*', 'missing'], unmatched: ['n1*', 'missing'] },
      {
        setup: { files: { 'x.txt': 'x\n' }, untracked: ['untracked.txt'] },
        args: ['untr*'],
        unmatched: ['untr*'],
      },
      {
        setup: { files: { 'a.txt': 'a\n' }, staged: ['new.txt'] },
        source: 'HEAD',
        args: ['new*'],
        unmatched: ['new*'],
      },
      {
        setup: { files: { 'a.txt': 'a\n' }, staged: ['new.txt'] },
        source: 'HEAD',
        args: ['new.txt'],
        unmatched: ['new.txt'],
      },
    ])('When git and tsgit checkout $args', ({ setup, source, args, unmatched }) => {
      it('Then both refuse every unmatched pathspec and leave the index and the files', async () => {
        // Arrange
        const gitRepo = await built('git', setup);
        const tsgitRepo = await built('tsgit', setup);
        const sut = checkout;
        const head = source === undefined ? [] : [source];

        // Act
        const git = tryRunGitWithExit(['-C', gitRepo, 'checkout', ...head, '--', ...args]);
        const refusal = await refusalOf(() =>
          sut(createNodeContext({ workDir: tsgitRepo }), {
            paths: [...args],
            ...(source === undefined ? {} : { source }),
          }),
        );

        // Assert
        expect(git.exitCode).toBe(1);
        expect(git.stderr.trim().split('\n')).toEqual(unmatched.map(unmatchedLine));
        expect(refusal).toEqual(
          pathspecNoMatch(unmatched[0] as string, ...unmatched.slice(1)).data,
        );
        expect(snapshotOf(tsgitRepo)).toEqual(snapshotOf(gitRepo));
        expect(
          await readFile(path.join(tsgitRepo, args[args.length - 1] as string), 'utf8').catch(
            () => '',
          ),
        ).toBe(
          await readFile(path.join(gitRepo, args[args.length - 1] as string), 'utf8').catch(
            () => '',
          ),
        );
      });
    });

    describe('When git and tsgit checkout *.txt over a modified nested file', () => {
      it('Then both restore it', async () => {
        // Arrange
        const setup: Setup = { files: { 'a/b/c.txt': 'c\n' }, dirty: ['a/b/c.txt'] };
        const gitRepo = await built('git', setup);
        const tsgitRepo = await built('tsgit', setup);
        const sut = checkout;

        // Act
        runGit(['-C', gitRepo, 'checkout', '--', '*.txt']);
        await sut(createNodeContext({ workDir: tsgitRepo }), { paths: ['*.txt'] });

        // Assert
        expect(snapshotOf(tsgitRepo)).toEqual(snapshotOf(gitRepo));
        expect(snapshotOf(tsgitRepo).status).toBe('');
      });
    });

    describe.each([{ args: ['nomatch*'] }, { args: ['missing'] }, { args: ['a.txt'] }])(
      'When git and tsgit checkout $args while index.lock exists',
      ({ args }) => {
        it('Then both refuse on the lock and keep its bytes', async () => {
          // Arrange
          const gitRepo = await built('git', plain);
          const tsgitRepo = await built('tsgit', plain);
          for (const repo of [gitRepo, tsgitRepo]) {
            await writeFile(path.join(repo, '.git', 'index.lock'), 'held');
          }
          const sut = checkout;

          // Act
          const git = tryRunGitWithExit(['-C', gitRepo, 'checkout', '--', ...args]);
          const refusal = await refusalOf(() =>
            sut(createNodeContext({ workDir: tsgitRepo }), { paths: [...args] }),
          );

          // Assert
          expect(git.exitCode).toBe(128);
          expect(git.stderr).toContain('index.lock');
          expect((refusal as { code: string }).code).toBe('RESOURCE_LOCKED');
          expect(await readFile(path.join(tsgitRepo, '.git', 'index.lock'), 'utf8')).toBe('held');
        });
      },
    );

    describe.each([{ source: 'HEAD' }, { source: undefined }])(
      'When git and tsgit checkout *.nomatch over a corrupt index',
      ({ source }) => {
        it('Then both refuse on the index read before the pathspec', async () => {
          // Arrange
          const gitRepo = await built('git', plain);
          const tsgitRepo = await built('tsgit', plain);
          for (const repo of [gitRepo, tsgitRepo]) {
            await writeFile(path.join(repo, '.git', 'index'), Uint8Array.of(0, 0, 0, 0));
          }
          const head = source === undefined ? [] : [source];
          const sut = checkout;

          // Act
          const git = tryRunGitWithExit(['-C', gitRepo, 'checkout', ...head, '--', '*.nomatch']);
          const refusal = await refusalOf(() =>
            sut(createNodeContext({ workDir: tsgitRepo }), {
              paths: ['*.nomatch'],
              ...(source === undefined ? {} : { source }),
            }),
          );

          // Assert
          expect(git.exitCode).toBe(128);
          expect(git.stderr).toContain('index file smaller than expected');
          expect((refusal as { code: string }).code).toBe('INVALID_INDEX_HEADER');
        });
      },
    );
  },
);
