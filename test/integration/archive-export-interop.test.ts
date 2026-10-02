/**
 * Cross-tool interop — `archive` honours `export-ignore`. Each row builds a
 * repository with canonical git, lists what `git archive --format=tar` emits
 * (path, kind, executable bit) by reading the tar headers, and proves the
 * `archive()` entry stream names exactly the same members. The expected list
 * of every row is also pinned literally, so a row can never pass by both
 * sides being wrong in the same way.
 *
 * @proves
 *   surface:        archive
 *   bucket:         cross-tool-interop
 *   unique:         export-ignore decisions (set/unset/string/macro, directory and gitlink
 *                   slash matching, queued-directory flush order, empty subtrees, tree-sourced
 *                   attributes, info/attributes, bare repositories) match `git archive`
 *   interopSurface: archive
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { archive } from '../../src/application/commands/archive.js';
import { FILE_MODE } from '../../src/domain/objects/file-mode.js';
import { GIT_AVAILABLE, git, runGit, runGitBytes, runGitEnv } from './interop-helpers.js';

const BLOCK = 512;
const NAME_END = 100;
const MODE_FIELD = { start: 100, end: 108 };
const SIZE_FIELD = { start: 124, end: 136 };
const TYPE_OFFSET = 156;
const EXEC_BIT = 0o100;
const PAX_HEADER_TYPES = new Set(['g', 'x']);
const FAKE_SUBMODULE_SHA = 'cccccccccccccccccccccccccccccccccccccccc';
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

interface Member {
  readonly path: string;
  readonly kind: 'file' | 'dir' | 'symlink';
  readonly executable: boolean;
}

const cString = (bytes: Uint8Array, start: number, end: number): string => {
  const slice = bytes.subarray(start, end);
  const nul = slice.indexOf(0);
  return new TextDecoder().decode(nul === -1 ? slice : slice.subarray(0, nul));
};

const octal = (bytes: Uint8Array, field: { start: number; end: number }): number =>
  Number.parseInt(cString(bytes, field.start, field.end).trim() || '0', 8);

const KIND_BY_TYPEFLAG: Record<string, Member['kind']> = {
  '0': 'file',
  '2': 'symlink',
  '5': 'dir',
};

const tarMembers = (tar: Uint8Array): ReadonlyArray<Member> => {
  const members: Member[] = [];
  let offset = 0;
  while (offset + BLOCK <= tar.length && tar[offset] !== 0) {
    const header = tar.subarray(offset, offset + BLOCK);
    const type = String.fromCharCode(header[TYPE_OFFSET] as number);
    const size = octal(header, SIZE_FIELD);
    if (!PAX_HEADER_TYPES.has(type)) {
      members.push({
        path: cString(header, 0, NAME_END),
        kind: KIND_BY_TYPEFLAG[type] ?? 'file',
        executable: (octal(header, MODE_FIELD) & EXEC_BIT) !== 0,
      });
    }
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  return members;
};

const tsgitMember = (entry: { path: string; mode: string }): Member => {
  if (entry.mode === FILE_MODE.DIRECTORY || entry.mode === FILE_MODE.GITLINK) {
    return { path: `${entry.path}/`, kind: 'dir', executable: true };
  }
  if (entry.mode === FILE_MODE.SYMLINK) {
    return { path: entry.path, kind: 'symlink', executable: true };
  }
  return { path: entry.path, kind: 'file', executable: entry.mode === FILE_MODE.EXECUTABLE };
};

const gitMembers = (dir: string, args: ReadonlyArray<string>): ReadonlyArray<Member> =>
  tarMembers(runGitBytes(['-C', dir, 'archive', '--format=tar', ...args], { env: runGitEnv() }));

const tsgitMembers = async (
  dir: string,
  treeish: string,
  bare = false,
): Promise<ReadonlyArray<Member>> => {
  const ctx = bare
    ? createNodeContext({ workDir: dir, gitDir: dir, bare: true })
    : createNodeContext({ workDir: dir });
  const result = await archive(ctx, { treeish });
  const members: Member[] = [];
  for await (const entry of result.entries) members.push(tsgitMember(entry));
  return members;
};

const paths = (members: ReadonlyArray<Member>): ReadonlyArray<string> => members.map((m) => m.path);

type Layout = Readonly<Record<string, string | { readonly symlinkTo: string }>>;

const writeLayout = (dir: string, layout: Layout): void => {
  for (const [relative, content] of Object.entries(layout)) {
    const target = path.join(dir, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    if (typeof content === 'string') writeFileSync(target, content);
    else symlinkSync(content.symlinkTo, target);
  }
};

const commit = (dir: string): void => {
  git(dir, 'add', '-A', '-f');
  git(dir, 'commit', '-q', '-m', 'seed');
};

describe.skipIf(!GIT_AVAILABLE)('archive export-ignore interop', () => {
  const roots: string[] = [];

  const makeRepo = async (slug: string, layout: Layout): Promise<string> => {
    const dir = await mkdtemp(path.join(os.tmpdir(), `tsgit-interop-export-${slug}-`));
    roots.push(dir);
    runGit(['init', '-q', '-b', 'main', dir], { env: runGitEnv() });
    for (const [key, value] of [
      ['user.name', 'Ada'],
      ['user.email', 'ada@example.com'],
      ['commit.gpgSign', 'false'],
      ['tag.gpgSign', 'false'],
      ['core.autocrlf', 'false'],
      ['gc.auto', '0'],
    ] as const) {
      git(dir, 'config', key, value);
    }
    writeLayout(dir, layout);
    commit(dir);
    return dir;
  };

  afterAll(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  const expectParity = async (
    dir: string,
    treeish: string,
    expected: ReadonlyArray<string>,
  ): Promise<void> => {
    const fromGit = gitMembers(dir, [treeish]);
    const fromTsgit = await tsgitMembers(dir, treeish);
    expect(paths(fromGit)).toEqual(expected);
    expect(fromTsgit).toEqual(fromGit);
  };

  describe('Given file-level export-ignore rules', () => {
    describe('When the repository is archived', () => {
      it('Then a set attribute omits the file (E1)', async () => {
        // Arrange
        const dir = await makeRepo('e1', {
          '.gitattributes': 't1 export-ignore\n',
          t1: '1',
          k: '2',
        });

        // Act / Assert
        await expectParity(dir, 'HEAD', ['.gitattributes', 'k']);
      });

      it('Then unset, string-valued and unspecified attributes keep the file (E2)', async () => {
        // Arrange
        const dir = await makeRepo('e2', {
          '.gitattributes':
            't2 -export-ignore\nt3 export-ignore=true\nt4 export-ignore\nt4 !export-ignore\n',
          t2: '1',
          t3: '2',
          t4: '3',
        });

        // Act / Assert
        await expectParity(dir, 'HEAD', ['.gitattributes', 't2', 't3', 't4']);
      });

      it('Then a macro expanding to export-ignore omits the file (E3)', async () => {
        // Arrange
        const dir = await makeRepo('e3', {
          '.gitattributes': '[attr]hidden export-ignore\nt5 hidden\n',
          t5: '1',
          k: '2',
        });

        // Act / Assert
        await expectParity(dir, 'HEAD', ['.gitattributes', 'k']);
      });

      it('Then a symlink matching the rule is omitted (E8)', async () => {
        // Arrange
        const dir = await makeRepo('e8', {
          '.gitattributes': 'lnk export-ignore\n',
          lnk: { symlinkTo: 'k' },
          k: '1',
        });

        // Act / Assert
        await expectParity(dir, 'HEAD', ['.gitattributes', 'k']);
      });
    });
  });

  describe('Given directory-level export-ignore rules', () => {
    describe('When the repository is archived', () => {
      it('Then a directory ignored by name drops with every descendant (E4)', async () => {
        // Arrange
        const dir = await makeRepo('e4', {
          '.gitattributes': 'a export-ignore\n',
          'a/x': '1',
          'a/deep/y': '2',
          k: '3',
        });

        // Act / Assert
        await expectParity(dir, 'HEAD', ['.gitattributes', 'k']);
      });

      it('Then a directory ignored with a trailing slash drops with every descendant (E5)', async () => {
        // Arrange
        const dir = await makeRepo('e5', {
          '.gitattributes': 'b/ export-ignore\n',
          'b/x': '1',
          k: '2',
        });

        // Act / Assert
        await expectParity(dir, 'HEAD', ['.gitattributes', 'k']);
      });

      it('Then dir/** keeps the directory and drops its children (E6)', async () => {
        // Arrange
        const dir = await makeRepo('e6', {
          '.gitattributes': 'c/** export-ignore\n',
          'c/x': '1',
        });

        // Act / Assert
        await expectParity(dir, 'HEAD', ['.gitattributes', 'c/']);
      });

      it('Then a directory whose only content is ignored is never emitted (E7)', async () => {
        // Arrange
        const dir = await makeRepo('e7', {
          '.gitattributes': 'd/e export-ignore\n',
          'd/e/z': '1',
          k: '2',
        });

        // Act / Assert
        await expectParity(dir, 'HEAD', ['.gitattributes', 'k']);
      });

      it('Then a directory-only rule spares a same-named file and drops the directory (E9)', async () => {
        // Arrange
        const dir = await makeRepo('e9', {
          '.gitattributes': 'foo/ export-ignore\n',
          foo: 'file',
          'x/foo/k': '1',
        });

        // Act / Assert
        await expectParity(dir, 'HEAD', ['.gitattributes', 'foo']);
      });

      it('Then a directory-only rule drops a gitlink of that name', async () => {
        // Arrange
        const dir = await makeRepo('gitlink', { '.gitattributes': 'sm/ export-ignore\n', k: '1' });
        git(dir, 'update-index', '--add', '--cacheinfo', `160000,${FAKE_SUBMODULE_SHA},sm`);
        git(dir, 'commit', '-q', '-m', 'gitlink');

        // Act / Assert
        await expectParity(dir, 'HEAD', ['.gitattributes', 'k']);
      });

      it('Then an ignored gitlink still flushes its parent directory', async () => {
        // Arrange
        const dir = await makeRepo('gitlink-dir', { '.gitattributes': 'd/sm export-ignore\n' });
        git(dir, 'update-index', '--add', '--cacheinfo', `160000,${FAKE_SUBMODULE_SHA},d/sm`);
        git(dir, 'commit', '-q', '-m', 'gitlink');

        // Act / Assert
        await expectParity(dir, 'HEAD', ['.gitattributes', 'd/']);
      });
    });
  });

  describe('Given a tree holding an empty subtree', () => {
    describe('When the tree is archived', () => {
      it('Then the empty subtree is not emitted (E10)', async () => {
        // Arrange
        const dir = await makeRepo('e10', { k: '1' });
        const blob = git(dir, 'rev-parse', 'HEAD:k').trim();
        const mktree = `040000 tree ${EMPTY_TREE}\tempty\n100644 blob ${blob}\tkeep\n`;
        const tree = runGit(['-C', dir, 'mktree'], { input: mktree, env: runGitEnv() }).trim();
        const commitId = git(dir, 'commit-tree', '-m', 'x', tree).trim();
        git(dir, 'update-ref', 'HEAD', commitId);

        // Act / Assert
        await expectParity(dir, 'HEAD', ['keep']);
      });
    });
  });

  describe('Given attributes living in the archived tree', () => {
    describe('When a subdirectory is archived', () => {
      it("Then that directory's .gitattributes is the root file and the repository root is invisible (E11)", async () => {
        // Arrange
        const dir = await makeRepo('e11', {
          '.gitattributes': 'x export-ignore\n',
          'sub/.gitattributes': 'y export-ignore\n',
          'sub/x': '1',
          'sub/y': '2',
        });

        // Act / Assert
        await expectParity(dir, 'HEAD:sub', ['.gitattributes', 'x']);
      });
    });

    describe('When the work tree .gitattributes is edited but uncommitted', () => {
      it('Then the committed rules still decide (E13)', async () => {
        // Arrange
        const dir = await makeRepo('e13', {
          '.gitattributes': 't1 export-ignore\n',
          t1: '1',
          keep: '2',
        });
        writeFileSync(path.join(dir, '.gitattributes'), 'keep export-ignore\n');

        // Act / Assert
        await expectParity(dir, 'HEAD', ['.gitattributes', 'keep']);
      });
    });

    describe('When .git/info/attributes names a file', () => {
      it('Then the file is omitted and its directory is emitted (E14)', async () => {
        // Arrange
        const dir = await makeRepo('e14', { 'g/x': '1', k: '2' });
        writeFileSync(path.join(dir, '.git', 'info', 'attributes'), 'g/x export-ignore\n');

        // Act / Assert
        await expectParity(dir, 'HEAD', ['g/', 'k']);
      });
    });

    describe('When the repository is a bare clone', () => {
      it('Then the committed .gitattributes applies (E15)', async () => {
        // Arrange
        const dir = await makeRepo('e15', {
          '.gitattributes': 't1 export-ignore\n',
          t1: '1',
          k: '2',
        });
        const bare = `${dir}-bare.git`;
        roots.push(bare);
        runGit(['clone', '-q', '--bare', dir, bare], { env: runGitEnv() });

        // Act
        const fromGit = gitMembers(bare, ['HEAD']);
        const fromTsgit = await tsgitMembers(bare, 'HEAD', true);

        // Assert
        expect(paths(fromGit)).toEqual(['.gitattributes', 'k']);
        expect(fromTsgit).toEqual(fromGit);
      });
    });

    describe('When the treeish is a tree id', () => {
      it('Then the tree attributes apply (E16)', async () => {
        // Arrange
        const dir = await makeRepo('e16', {
          '.gitattributes': 't1 export-ignore\n',
          t1: '1',
          k: '2',
        });
        const tree = git(dir, 'rev-parse', 'HEAD^{tree}').trim();

        // Act / Assert
        await expectParity(dir, tree, ['.gitattributes', 'k']);
      });
    });

    describe('When a nested .gitattributes is committed as a symlink', () => {
      it('Then its rules are not read (E17)', async () => {
        // Arrange
        const dir = await makeRepo('e17', {
          'rules.txt': 'q export-ignore\n',
          's/.gitattributes': { symlinkTo: '../rules.txt' },
          's/q': '1',
        });

        // Act / Assert
        await expectParity(dir, 'HEAD', ['rules.txt', 's/', 's/.gitattributes', 's/q']);
      });
    });
  });

  describe('Given a path argument naming an ignored file', () => {
    describe('When git archives it', () => {
      it('Then git emits an empty archive, which tsgit has no pathspec to reproduce (E12)', async () => {
        // Arrange
        const dir = await makeRepo('e12', { '.gitattributes': 't1 export-ignore\n', t1: '1' });

        // Act
        const result = gitMembers(dir, ['HEAD', 't1']);

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given a plain repository with an executable file', () => {
    describe('When the tar members are listed', () => {
      it('Then the tar reader reports directories and the executable bit', async () => {
        // Arrange
        const dir = await makeRepo('plain', { 'a/b': '1', run: '#!/bin/sh\n' });
        execFileSync('git', ['-C', dir, 'update-index', '--chmod=+x', 'run'], { env: runGitEnv() });
        git(dir, 'commit', '-q', '-m', 'exec');

        // Act / Assert
        await expectParity(dir, 'HEAD', ['a/', 'a/b', 'run']);
        expect(gitMembers(dir, ['HEAD']).find((m) => m.path === 'run')?.executable).toBe(true);
      });
    });
  });
});
