/**
 * Cross-tool interop — `archive` honours `export-ignore` and `export-subst`.
 *
 * export-ignore: each row builds a repository with canonical git, lists what
 * `git archive --format=tar` emits (path, kind, executable bit) by reading the
 * tar headers, and proves the `archive()` entry stream names exactly the same
 * members.
 *
 * export-subst: each row reads every regular member's bytes out of
 * `git archive --format=tar` and proves the `archive()` entry stream carries
 * the same expanded bytes — placeholders, `$Format:` terminators, the describe
 * budget, mailmap and decoration sources, signature verification through a
 * `gpg.program`, commit-encoding transcoding, now-relative dates and the order
 * in which refusals win. Both tools run under `TZ=UTC`.
 *
 * The expected bytes of every row are also pinned literally wherever they do
 * not hold an object id or the clock, so a row can never pass by both sides
 * being wrong in the same way.
 *
 * @proves
 *   surface:        archive
 *   bucket:         cross-tool-interop
 *   unique:         export-ignore decisions (set/unset/string/macro, directory and gitlink
 *                   slash matching, queued-directory flush order, empty subtrees, tree-sourced
 *                   attributes, info/attributes, bare repositories) and export-subst expansion
 *                   (every placeholder class, signature verification, encodings, refusal
 *                   order) match `git archive`
 *   interopSurface: archive, verifyBuffer
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { type ArchiveEntry, archive } from '../../src/application/commands/archive.js';
import { __resetConfigCacheForTests } from '../../src/application/primitives/config-read.js';
import { TsgitError } from '../../src/domain/index.js';
import { FILE_MODE } from '../../src/domain/objects/file-mode.js';
import { openRepository } from '../../src/index.node.js';
import {
  GIT_AVAILABLE,
  git,
  runGit,
  runGitBytes,
  runGitEnv,
  tryRunGitWithExit,
} from './interop-helpers.js';
import { mutateMidxOrThrow, writeMultiPackIndex } from './midx-fixture-helpers.js';

const BLOCK = 512;
const NAME_END = 100;
const MODE_FIELD = { start: 100, end: 108 };
const SIZE_FIELD = { start: 124, end: 136 };
const TYPE_OFFSET = 156;
const LINK_FIELD = { start: 157, end: 257 };
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

interface TarRecord {
  readonly type: string;
  readonly path: string;
  readonly mode: number;
  readonly linkTarget: string;
  readonly content: Uint8Array;
}

const tarRecords = (tar: Uint8Array): ReadonlyArray<TarRecord> => {
  const records: TarRecord[] = [];
  let offset = 0;
  while (offset + BLOCK <= tar.length && tar[offset] !== 0) {
    const header = tar.subarray(offset, offset + BLOCK);
    const size = octal(header, SIZE_FIELD);
    const body = offset + BLOCK;
    records.push({
      type: String.fromCharCode(header[TYPE_OFFSET] as number),
      path: cString(header, 0, NAME_END),
      mode: octal(header, MODE_FIELD),
      linkTarget: cString(header, LINK_FIELD.start, LINK_FIELD.end),
      content: tar.subarray(body, body + size),
    });
    offset = body + Math.ceil(size / BLOCK) * BLOCK;
  }
  return records;
};

const tarMembers = (tar: Uint8Array): ReadonlyArray<Member> =>
  tarRecords(tar)
    .filter((record) => !PAX_HEADER_TYPES.has(record.type))
    .map((record) => ({
      path: record.path,
      kind: KIND_BY_TYPEFLAG[record.type] ?? 'file',
      executable: (record.mode & EXEC_BIT) !== 0,
    }));

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
      it('Then a set attribute omits the file', async () => {
        // Arrange
        const dir = await makeRepo('e1', {
          '.gitattributes': 't1 export-ignore\n',
          t1: '1',
          k: '2',
        });

        // Act / Assert
        await expectParity(dir, 'HEAD', ['.gitattributes', 'k']);
      });

      it('Then unset, string-valued and unspecified attributes keep the file', async () => {
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

      it('Then a macro expanding to export-ignore omits the file', async () => {
        // Arrange
        const dir = await makeRepo('e3', {
          '.gitattributes': '[attr]hidden export-ignore\nt5 hidden\n',
          t5: '1',
          k: '2',
        });

        // Act / Assert
        await expectParity(dir, 'HEAD', ['.gitattributes', 'k']);
      });

      it('Then a symlink matching the rule is omitted', async () => {
        // Arrange
        const dir = await makeRepo('e8', {
          '.gitattributes': 'lnk export-ignore\n',
          lnk: { symlinkTo: 'k' },
          k: '1',
        });

        // Act / Assert
        await expectParity(dir, 'HEAD', ['.gitattributes', 'k']);
      });

      it('Then a rule without a slash matches its ** against a basename alone, never across a directory', async () => {
        // Arrange
        const dir = await makeRepo('basename', {
          '.gitattributes': 'a**b export-ignore\n',
          'x/ab': '1',
          'q/a/xb': '2',
        });

        // Act / Assert
        await expectParity(dir, 'HEAD', ['.gitattributes', 'q/', 'q/a/', 'q/a/xb', 'x/']);
      });
    });
  });

  describe('Given directory-level export-ignore rules', () => {
    describe('When the repository is archived', () => {
      it('Then a directory ignored by name drops with every descendant', async () => {
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

      it('Then a directory ignored with a trailing slash drops with every descendant', async () => {
        // Arrange
        const dir = await makeRepo('e5', {
          '.gitattributes': 'b/ export-ignore\n',
          'b/x': '1',
          k: '2',
        });

        // Act / Assert
        await expectParity(dir, 'HEAD', ['.gitattributes', 'k']);
      });

      it('Then dir/** keeps the directory and drops its children', async () => {
        // Arrange
        const dir = await makeRepo('e6', {
          '.gitattributes': 'c/** export-ignore\n',
          'c/x': '1',
        });

        // Act / Assert
        await expectParity(dir, 'HEAD', ['.gitattributes', 'c/']);
      });

      it('Then a directory whose only content is ignored is never emitted', async () => {
        // Arrange
        const dir = await makeRepo('e7', {
          '.gitattributes': 'd/e export-ignore\n',
          'd/e/z': '1',
          k: '2',
        });

        // Act / Assert
        await expectParity(dir, 'HEAD', ['.gitattributes', 'k']);
      });

      it.each([
        { rule: '* export-ignore', expected: ['d/', 't'] },
        { rule: '** export-ignore', expected: ['d/', 't'] },
        { rule: '/* export-ignore', expected: ['d/', 't'] },
        {
          rule: '/ export-ignore',
          expected: ['d/', 'd/.gitattributes', 'd/a', 'd/e/', 'd/e/b', 't'],
        },
        {
          rule: '. export-ignore',
          expected: ['d/', 'd/.gitattributes', 'd/a', 'd/e/', 'd/e/b', 't'],
        },
      ])(
        "Then a directory's own '$rule' never applies to the directory itself",
        async ({ rule, expected }) => {
          // Arrange
          const dir = await makeRepo('own', {
            'd/.gitattributes': `${rule}\n`,
            'd/a': '1',
            'd/e/b': '2',
            t: '3',
          });

          // Act / Assert
          await expectParity(dir, 'HEAD', expected);
        },
      );

      it('Then a directory-only rule spares a same-named file and drops the directory', async () => {
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
      it('Then the empty subtree is not emitted', async () => {
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
      it("Then that directory's .gitattributes is the root file and the repository root is invisible", async () => {
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
      it('Then the committed rules still decide', async () => {
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
      it('Then the file is omitted and its directory is emitted', async () => {
        // Arrange
        const dir = await makeRepo('e14', { 'g/x': '1', k: '2' });
        writeFileSync(path.join(dir, '.git', 'info', 'attributes'), 'g/x export-ignore\n');

        // Act / Assert
        await expectParity(dir, 'HEAD', ['g/', 'k']);
      });
    });

    describe('When the repository is a bare clone', () => {
      it('Then the committed .gitattributes applies', async () => {
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
      it('Then the tree attributes apply', async () => {
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
      it('Then its rules are not read', async () => {
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
      it('Then git emits an empty archive, which tsgit has no pathspec to reproduce', async () => {
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

const REGULAR_TYPEFLAG = '0';
const SYMLINK_TYPEFLAG = '2';
const SUBST_MESSAGE = 'msg subject line\n\nbody para\n\nSigned-off-by: X <x@y>\n';
const AUTHOR_IDENT = 'A U Thor <author@example.com> 1700000200 +0545';
const COMMITTER_IDENT = 'C O Mitter <committer@example.com> 1700000300 +0000';
const SUBST_IDENTS = {
  GIT_AUTHOR_NAME: 'A U Thor',
  GIT_AUTHOR_EMAIL: 'author@example.com',
  GIT_AUTHOR_DATE: '1700000200 +0545',
  GIT_COMMITTER_NAME: 'C O Mitter',
  GIT_COMMITTER_EMAIL: 'committer@example.com',
  GIT_COMMITTER_DATE: '1700000300 +0000',
} as const;
const SEED_DATES = {
  GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_DATE: '1700000000 +0000',
} as const;
const SECONDS_PER_HOUR = 3600;
const EXPORT_SUBST_ALL = '* export-subst\n';
const ARMORED_SIGNATURE =
  '-----BEGIN PGP SIGNATURE-----\n\niQEzBAAA/CANNEDSIGNATUREBLOCK==\n-----END PGP SIGNATURE-----\n';

const SIGNATURE_FORMAT = '[$Format:%G?|%GS|%GK|%GF|%GP|%GT$]';

const binaryAvailable = (command: string, args: ReadonlyArray<string>): boolean => {
  try {
    execFileSync(command, args as string[], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const GPG_AVAILABLE = binaryAvailable('gpg', ['--version']);
const SSH_KEYGEN_AVAILABLE = binaryAvailable('which', ['ssh-keygen']);

const substEnv = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  TZ: 'UTC',
  ...SUBST_IDENTS,
  ...overrides,
});

const latin1 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('latin1');

const gitArchive = (
  dir: string,
  treeish: string,
  env: NodeJS.ProcessEnv = {},
): ReadonlyArray<TarRecord> =>
  tarRecords(runGitBytes(['-C', dir, 'archive', '--format=tar', treeish], { env: substEnv(env) }));

const gitFiles = (
  dir: string,
  treeish: string,
  env: NodeJS.ProcessEnv = {},
): ReadonlyMap<string, string> =>
  new Map(
    gitArchive(dir, treeish, env)
      .filter((record) => record.type === REGULAR_TYPEFLAG)
      .map((record) => [record.path, latin1(record.content)]),
  );

const tsgitEntries = async (dir: string, treeish: string): Promise<ReadonlyArray<ArchiveEntry>> => {
  __resetConfigCacheForTests();
  const repo = await openRepository({ cwd: dir });
  try {
    const result = await repo.archive({ treeish });
    const entries: ArchiveEntry[] = [];
    for await (const entry of result.entries) entries.push(entry);
    return entries;
  } finally {
    await repo.dispose();
  }
};

const tsgitFiles = async (dir: string, treeish: string): Promise<ReadonlyMap<string, string>> =>
  new Map(
    (await tsgitEntries(dir, treeish))
      .filter((entry) => entry.content !== undefined && entry.mode !== FILE_MODE.SYMLINK)
      .map((entry) => [entry.path, latin1(entry.content as Uint8Array)]),
  );

const tsgitRefusal = async (dir: string, treeish: string): Promise<TsgitError> => {
  try {
    await tsgitEntries(dir, treeish);
  } catch (error) {
    if (error instanceof TsgitError) return error;
    throw error;
  }
  return expect.fail('expected tsgit to refuse the archive');
};

const gitRefusal = (dir: string, treeish: string): { exitCode: number; stderr: string } => {
  const { exitCode, stderr } = tryRunGitWithExit(
    ['-C', dir, 'archive', '--format=tar', '-o', path.join(dir, '.git', 'out.tar'), treeish],
    { env: substEnv() },
  );
  return { exitCode, stderr };
};

const head = (dir: string, rev = 'HEAD'): string =>
  runGit(['-C', dir, 'rev-parse', rev], { env: substEnv() }).trim();

const commitAll = (dir: string, message: string, env: NodeJS.ProcessEnv = {}): void => {
  runGit(['-C', dir, 'add', '-A', '-f'], { env: substEnv() });
  runGit(['-C', dir, 'commit', '-q', '--cleanup=verbatim', '-F', '-'], {
    input: message,
    env: substEnv(env),
  });
};

/** Writes a commit object by hand, for the headers `git commit` never emits. */
const commitRaw = (
  dir: string,
  headers: string,
  message: Uint8Array,
  idents: { readonly author: string; readonly committer: string } = {
    author: AUTHOR_IDENT,
    committer: COMMITTER_IDENT,
  },
): string => {
  runGit(['-C', dir, 'add', '-A', '-f'], { env: substEnv() });
  const tree = runGit(['-C', dir, 'write-tree'], { env: substEnv() }).trim();
  const preamble = `tree ${tree}\nparent ${head(dir)}\nauthor ${idents.author}\ncommitter ${idents.committer}\n${headers}\n`;
  const raw = Buffer.concat([Buffer.from(preamble), message]);
  const oid = runGit(['-C', dir, 'hash-object', '-t', 'commit', '--literally', '-w', '--stdin'], {
    input: raw,
    env: substEnv(),
  }).trim();
  runGit(['-C', dir, 'update-ref', 'refs/heads/main', oid], { env: substEnv() });
  return oid;
};

const continuationLines = (value: string): string => value.trimEnd().split('\n').join('\n ');

const writeScript = (dir: string, name: string, body: string): string => {
  const script = path.join(dir, '.git', name);
  writeFileSync(script, `#!/bin/sh\n${body}`);
  chmodSync(script, 0o755);
  return script;
};

describe.skipIf(!GIT_AVAILABLE)('archive export-subst interop', () => {
  const roots: string[] = [];
  let previousTz: string | undefined;

  beforeAll(() => {
    previousTz = process.env.TZ;
    process.env.TZ = 'UTC';
  });

  afterAll(async () => {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  const makeSubstRepo = async (slug: string, layout: Layout): Promise<string> => {
    const dir = await mkdtemp(path.join(os.tmpdir(), `tsgit-interop-subst-${slug}-`));
    roots.push(dir);
    runGit(['init', '-q', '-b', 'main', dir], { env: substEnv() });
    for (const [key, value] of [
      ['commit.gpgSign', 'false'],
      ['tag.gpgSign', 'false'],
      ['core.autocrlf', 'false'],
    ] as const) {
      git(dir, 'config', key, value);
    }
    writeLayout(dir, { seed: 'seed\n' });
    commitAll(dir, 'seed\n', SEED_DATES);
    runGit(['-C', dir, 'tag', '-a', 'v1', '-m', 'v1'], { env: substEnv(SEED_DATES) });
    writeLayout(dir, { '.gitattributes': EXPORT_SUBST_ALL, ...layout });
    commitAll(dir, SUBST_MESSAGE);
    return dir;
  };

  const expectSameExpansion = async (
    dir: string,
    treeish: string,
    expected: Readonly<Record<string, string>>,
  ): Promise<void> => {
    const fromGit = gitFiles(dir, treeish);
    const fromTsgit = await tsgitFiles(dir, treeish);
    expect(
      Object.fromEntries(Object.keys(expected).map((file) => [file, fromGit.get(file)])),
    ).toEqual(expected);
    expect(fromTsgit).toEqual(fromGit);
  };

  describe('Given the placeholder table archived from one commit', () => {
    // Each row: [file, content, git's literal bytes or undefined when they hold an object id].
    const rows: ReadonlyArray<readonly [string, string, string | undefined]> = [
      ['id-H', '[$Format:%H$]', undefined],
      ['id-h', '[$Format:%h$]', undefined],
      ['id-T', '[$Format:%T|%t$]', undefined],
      ['id-P', '[$Format:%P|%p$]', undefined],
      ['ident-a', '[$Format:%an|%ae|%al$]', '[A U Thor|author@example.com|author]'],
      ['ident-aN-mapped', '[$Format:%aN|%aE|%aL$]', '[A U Thor|author@example.com|author]'],
      ['ident-c', '[$Format:%cn|%ce|%cl$]', '[C O Mitter|committer@example.com|committer]'],
      ['date-ad', '[$Format:%ad$]', '[Wed Nov 15 04:01:40 2023 +0545]'],
      ['date-aD-rfc', '[$Format:%aD$]', '[Wed, 15 Nov 2023 04:01:40 +0545]'],
      ['date-at', '[$Format:%at|%ct$]', '[1700000200|1700000300]'],
      ['date-ai', '[$Format:%ai$]', '[2023-11-15 04:01:40 +0545]'],
      ['date-aI-strict', '[$Format:%aI$]', '[2023-11-15T04:01:40+05:45]'],
      ['date-as', '[$Format:%as|%ah$]', '[2023-11-15|Nov 15 2023]'],
      ['date-ar', '[$Format:%ar$]', undefined],
      [
        'date-cd',
        '[$Format:%cd|%cD$]',
        '[Tue Nov 14 22:18:20 2023 +0000|Tue, 14 Nov 2023 22:18:20 +0000]',
      ],
      ['date-cI', '[$Format:%cI$]', '[2023-11-14T22:18:20Z]'],
      ['msg-s', '[$Format:%s|%f|%e$]', '[msg subject line|msg-subject-line|]'],
      ['msg-b', '[$Format:%b$]', '[body para\n\nSigned-off-by: X <x@y>\n]'],
      ['msg-B-raw', '[$Format:%B$]', `[${SUBST_MESSAGE}]`],
      ['literals', '[$Format:%n|%%|%x41|%x00|%m$]', '[\n|%|A|\0|>]'],
      ['sig', '[$Format:%G?|%GT|%GG|%GS|%GK|%GF|%GP|%gd|%gs|%gn$]', '[N|undefined||||||||]'],
      ['color-never', '[$Format:%Cred%C(red)%C(auto)%Creset%C(never,red)$]', '[]'],
      ['color-always', '[$Format:%C(always,red)X$]', '[\u001b[31mX]'],
      ['pad-left', '[$Format:%<(8)%an|%<(3,trunc)%an|$]', '[A U Thor|A..|]'],
      ['pad-right', '[$Format:%>(8)%an|%><(9)%an|$]', '[A U Thor|A U Thor |]'],
      ['pad-column', '0123456789abcdef[$Format:%<|(12)%h$]', undefined],
      ['pad-column-after-text', 'prefix [$Format:%<|(20)%an$]|', 'prefix [A U Thor    ]|'],
      ['wrap', '[$Format:%w(10,2,4)%s$]', '[  msg\n    subject\n    line]'],
      [
        'wrap-after-text',
        '0123456789[$Format:%w(10,2,4)%s$]',
        '0123456789[  msg\n    subject\n    line]',
      ],
      [
        'magic',
        '[$Format:%+s|%-s|% s$]',
        '[\nmsg subject line|msg subject line| msg subject line]',
      ],
      [
        'trailers',
        '[$Format:%(trailers)|%(trailers:only)$]',
        '[Signed-off-by: X <x@y>\n|Signed-off-by: X <x@y>\n]',
      ],
      ['trailers-key', '[$Format:%(trailers:key=Signed-off-by,valueonly)$]', '[X <x@y>\n]'],
      [
        'decorate',
        '[$Format:%d|%D|%(decorate:prefix=[,suffix=])$]',
        '[ (HEAD -> main)|HEAD -> main|[HEAD -> main]]',
      ],
      ['describe', '[$Format:%(describe)$]', undefined],
      [
        'declined',
        '[$Format:%S|%N|%q|%Zz|%xZZ|%Gx|%(unknown)|%+w(5)|%+N$]',
        '[%S|%N|%q|%Zz|%xZZ|%Gx|%(unknown)|%+w(5)|N]',
      ],
    ];
    let fromGit: ReadonlyMap<string, string> = new Map();
    let fromTsgit: ReadonlyMap<string, string> = new Map();

    beforeAll(async () => {
      const dir = await makeSubstRepo(
        'table',
        Object.fromEntries(rows.map(([file, content]) => [`rows/${file}`, content])),
      );
      fromGit = gitFiles(dir, 'HEAD');
      fromTsgit = await tsgitFiles(dir, 'HEAD');
    });

    describe('When the commit is archived', () => {
      it.each(rows)('Then %s expands to the bytes git writes', (file, _content, expected) => {
        // Arrange
        const member = `rows/${file}`;

        // Act
        const result = fromTsgit.get(member);

        // Assert
        if (expected !== undefined) expect(fromGit.get(member)).toBe(expected);
        expect(result).toBe(fromGit.get(member));
      });
    });
  });
  describe('Given a commit whose message has no body', () => {
    describe('When magic placeholders expand an empty body', () => {
      it('Then %-b deletes the preceding line feeds and % b adds nothing', async () => {
        // Arrange
        const dir = await makeSubstRepo('empty-body', {});
        writeLayout(dir, { minus: 'x\n$Format:%-b$', space: '[$Format:% b|%+b$]' });
        commitAll(dir, 'subject only\n');

        // Act / Assert
        await expectSameExpansion(dir, 'HEAD', { minus: 'x', space: '[|]' });
      });
    });
  });

  describe('Given $Format: occurrences with unusual terminators', () => {
    describe('When the commit is archived', () => {
      it('Then the first later $ terminates, a missing one keeps the tail, a NUL ends the format', async () => {
        // Arrange
        const dir = await makeSubstRepo('terminators', {
          s1: 'unterminated $Format:%H\n$Format:$ empty',
          s2: 'tail $Format:%H',
          s3: '$Format:%h\0%H$',
        });
        const id = head(dir);

        // Act / Assert
        await expectSameExpansion(dir, 'HEAD', {
          s1: `unterminated ${id}\nFormat:$ empty`,
          s2: 'tail $Format:%H',
          s3: id.slice(0, 7),
        });
      });
    });
  });

  describe('Given export-subst on a binary blob, a symlink and a big file', () => {
    describe('When the commit is archived', () => {
      it('Then the binary and the big file expand and the symlink target stays verbatim', async () => {
        // Arrange
        const dir = await makeSubstRepo('kinds', {});
        git(dir, 'config', 'core.bigFileThreshold', '1000');
        const filler = 'x'.repeat(2048);
        writeLayout(dir, {
          binary: '\0bin [$Format:%H$]',
          big: `${filler}[$Format:%H$]`,
          lnk: { symlinkTo: '$Format:%H$' },
        });
        commitAll(dir, 'kinds\n');
        const id = head(dir);

        // Act
        const link = (await tsgitEntries(dir, 'HEAD')).find((entry) => entry.path === 'lnk');

        // Assert
        await expectSameExpansion(dir, 'HEAD', {
          binary: `\0bin [${id}]`,
          big: `${filler}[${id}]`,
        });
        const gitLink = gitArchive(dir, 'HEAD').find((record) => record.type === SYMLINK_TYPEFLAG);
        expect(gitLink?.linkTarget).toBe('$Format:%H$');
        expect(latin1(link?.content ?? new Uint8Array())).toBe(gitLink?.linkTarget);
      });
    });
  });

  describe('Given a tree id and an annotated tag as the tree-ish', () => {
    describe('When each is archived', () => {
      it('Then the tree id never expands and the tag peels to its commit', async () => {
        // Arrange
        const dir = await makeSubstRepo('treeish', { f: '[$Format:%H$]' });
        runGit(['-C', dir, 'tag', '-a', 'v2', '-m', 'v2'], { env: substEnv() });
        const tree = head(dir, 'HEAD^{tree}');

        // Act / Assert
        await expectSameExpansion(dir, tree, { f: '[$Format:%H$]' });
        await expectSameExpansion(dir, 'v2', { f: `[${head(dir)}]` });
      });
    });
  });

  describe('Given %(describe) in two files', () => {
    describe('When the repository has no tag', () => {
      it('Then the first file spends the budget on an empty describe and the second stays literal', async () => {
        // Arrange
        const dir = await makeSubstRepo('describe-untagged', {
          'a.txt': 'A=$Format:%(describe)$',
          'z.txt': 'Z=$Format:%(describe)$',
        });
        git(dir, 'tag', '-d', 'v1');

        // Act / Assert
        await expectSameExpansion(dir, 'HEAD', { 'a.txt': 'A=', 'z.txt': 'Z=%(describe)' });
      });
    });

    describe('When a tag describes the commit', () => {
      it('Then pre-order decides the spender and %(describe:tags) after it stays literal', async () => {
        // Arrange
        const dir = await makeSubstRepo('describe-tagged', {
          'b.txt': 'B=$Format:%(describe:tags)$',
          'a/x.txt': 'X=$Format:%(describe)$',
        });
        const short = head(dir).slice(0, 7);

        // Act / Assert
        await expectSameExpansion(dir, 'HEAD', {
          'a/x.txt': `X=v1-1-g${short}`,
          'b.txt': 'B=%(describe:tags)',
        });
      });
    });

    describe('When the describe asks for a shorter abbreviation', () => {
      it('Then abbrev=4 shortens the suffix as git does', async () => {
        // Arrange
        const dir = await makeSubstRepo('describe-abbrev', {
          d: '[$Format:%(describe:abbrev=4)$]',
        });

        // Act / Assert
        await expectSameExpansion(dir, 'HEAD', {
          d: `[v1-1-g${head(dir).slice(0, 4)}]`,
        });
      });
    });
  });

  describe('Given %(count) or %(total) in an export-subst file', () => {
    describe.each([
      ['%(count)', 'count'],
      ['%(total)', 'total'],
    ])('When a file holds %s', (placeholder, slug) => {
      it('Then both tools refuse the archive with the same placeholder', async () => {
        // Arrange
        const dir = await makeSubstRepo(slug, { f: `before [$Format:${placeholder}$]` });

        // Act
        const result = await tsgitRefusal(dir, 'HEAD');

        // Assert
        expect(gitRefusal(dir, 'HEAD')).toEqual({
          exitCode: 128,
          stderr: `fatal: ${placeholder} is not supported by this command\n`,
        });
        expect(result.data).toEqual({
          code: 'FORMAT_PLACEHOLDER_UNSUPPORTED',
          placeholder,
          reason: 'not-supported',
        });
      });
    });
  });
  describe('Given a committed .mailmap mapping the author', () => {
    const MAPPED = '[$Format:%aN|%aE|%aL$]';
    const mailmapRepo = (slug: string): Promise<string> =>
      makeSubstRepo(slug, {
        '.mailmap': 'Mapped Name <mapped@example.com> A U Thor <author@example.com>\n',
        m: MAPPED,
      });

    describe('When the worktree file is the committed one', () => {
      it('Then the mapped ident expands', async () => {
        // Arrange
        const dir = await mailmapRepo('mailmap-committed');

        // Act / Assert
        await expectSameExpansion(dir, 'HEAD', { m: '[Mapped Name|mapped@example.com|mapped]' });
      });
    });

    describe('When the worktree file carries an uncommitted edit', () => {
      it('Then the edit wins over the committed file', async () => {
        // Arrange
        const dir = await mailmapRepo('mailmap-edited');
        writeLayout(dir, {
          '.mailmap': 'Edited Name <edited@example.com> A U Thor <author@example.com>\n',
        });

        // Act / Assert
        await expectSameExpansion(dir, 'HEAD', { m: '[Edited Name|edited@example.com|edited]' });
      });
    });

    describe('When the worktree file is deleted', () => {
      it('Then the ident stays unmapped', async () => {
        // Arrange
        const dir = await mailmapRepo('mailmap-deleted');
        await rm(path.join(dir, '.mailmap'));

        // Act / Assert
        await expectSameExpansion(dir, 'HEAD', { m: '[A U Thor|author@example.com|author]' });
      });
    });

    describe.each([
      ['a revision expression', 'HEAD~0:.mailmap'],
      ['an abbreviated blob id', 'abbreviated'],
    ])('When mailmap.blob names the committed file through %s', (_label, blob) => {
      it('Then the mapped ident expands', async () => {
        // Arrange
        const dir = await mailmapRepo(`mailmap-blob-${blob === 'abbreviated' ? 'abbrev' : 'expr'}`);
        await rm(path.join(dir, '.mailmap'));
        const named =
          blob === 'abbreviated' ? git(dir, 'rev-parse', '--short', 'HEAD:.mailmap').trim() : blob;
        git(dir, 'config', 'mailmap.blob', named);

        // Act / Assert
        await expectSameExpansion(dir, 'HEAD', { m: '[Mapped Name|mapped@example.com|mapped]' });
      });
    });

    /** Writes loose blobs until two share a four-digit prefix and returns that prefix. */
    const ambiguousPrefix = (dir: string): string => {
      const scratch = path.join(dir, '.git', 'blobs');
      mkdirSync(scratch);
      const files = Array.from({ length: 1000 }, (_, index) => {
        const file = path.join(scratch, `b${index}`);
        writeFileSync(file, `blob ${index}\n`);
        return file;
      });
      const ids = git(dir, 'hash-object', '-w', ...files)
        .trim()
        .split('\n');
      const seen = new Set<string>();
      const shared = ids
        .map((id) => id.slice(0, 4))
        .find((prefix) => seen.has(prefix) || !seen.add(prefix));
      return shared as string;
    };

    /** Rebuilds the `error:` line git prints from the logger's constant message and its context. */
    const gitErrorLine = (message: string, context?: Readonly<Record<string, unknown>>): string =>
      message === 'unable to read mailmap object'
        ? `error: ${message} at ${String(context?.expression)}`
        : `error: ${message}`;

    describe.each([
      ['an abbreviated id two objects share', 'ambiguous'],
      ['a full object id naming no object', 'missing'],
    ])('When mailmap.blob is %s', (_label, kind) => {
      it('Then tsgit reports each error line git prints and leaves the ident unmapped', async () => {
        // Arrange
        const dir = await mailmapRepo(`mailmap-blob-${kind}`);
        await rm(path.join(dir, '.mailmap'));
        const named =
          kind === 'ambiguous' ? ambiguousPrefix(dir) : '0123456789012345678901234567890123456789';
        git(dir, 'config', 'mailmap.blob', named);
        const { stderr } = gitRefusal(dir, 'HEAD');
        const errors: string[] = [];
        __resetConfigCacheForTests();
        const ctx = {
          ...createNodeContext({ workDir: dir }),
          logger: {
            error: (message: string, context?: Readonly<Record<string, unknown>>) =>
              errors.push(gitErrorLine(message, context)),
          },
        };
        const sut = archive;

        // Act
        const result = await sut(ctx, { treeish: 'HEAD' });
        for await (const _entry of result.entries);

        // Assert
        const expected = stderr.split('\n').filter((line) => line.startsWith('error: '));
        expect(expected).not.toEqual([]);
        expect(errors).toEqual(expected);
        expect(await tsgitFiles(dir, 'HEAD')).toEqual(gitFiles(dir, 'HEAD'));
      });
    });

    describe('When a bare clone is archived', () => {
      it('Then HEAD:.mailmap maps the ident', async () => {
        // Arrange
        const source = await mailmapRepo('mailmap-source');
        const dir = `${source}-bare`;
        roots.push(dir);
        runGit(['clone', '-q', '--bare', source, dir], { env: substEnv() });

        // Act
        const result = await tsgitFiles(dir, 'HEAD');
        const bareContext = createNodeContext({ workDir: dir, gitDir: dir, bare: true });
        const fromContext = await archive(bareContext, { treeish: 'HEAD' });
        const expanded = new Map<string, string>();
        for await (const entry of fromContext.entries) {
          expanded.set(entry.path, latin1(entry.content ?? new Uint8Array()));
        }

        // Assert
        expect(gitFiles(dir, 'HEAD').get('m')).toBe('[Mapped Name|mapped@example.com|mapped]');
        expect(result).toEqual(gitFiles(dir, 'HEAD'));
        expect(expanded).toEqual(gitFiles(dir, 'HEAD'));
      });
    });
  });

  describe('Given refs of every decoration class on the archived commit', () => {
    const FORMAT = '[$Format:%d|%D|%(decorate:prefix=<,suffix=>,separator=;,tag=T:,pointer=~>)$]';
    const decoratedRepo = async (slug: string): Promise<string> => {
      const dir = await makeSubstRepo(slug, { f: FORMAT });
      for (const ref of [
        'refs/tags/lt2',
        'refs/stash',
        'refs/remotes/o/main',
        'refs/heads/side',
        'refs/custom/x',
      ]) {
        git(dir, 'update-ref', ref, 'HEAD');
      }
      return dir;
    };

    describe('When HEAD is attached to main', () => {
      it('Then every ref decorates the commit with HEAD pointing at main', async () => {
        // Arrange
        const dir = await decoratedRepo('decorate-attached');

        // Act / Assert
        await expectSameExpansion(dir, 'HEAD', {
          f:
            '[ (HEAD -> main, tag: lt2, refs/stash, o/main, side, refs/custom/x)' +
            '|HEAD -> main, tag: lt2, refs/stash, o/main, side, refs/custom/x' +
            '|<HEAD~>main;T:lt2;refs/stash;o/main;side;refs/custom/x>]',
        });
      });
    });

    describe('When HEAD is detached at the commit', () => {
      it('Then HEAD decorates on its own and main joins the branch list', async () => {
        // Arrange
        const dir = await decoratedRepo('decorate-detached');
        git(dir, 'checkout', '-q', '--detach');

        // Act / Assert
        await expectSameExpansion(dir, 'HEAD', {
          f:
            '[ (HEAD, tag: lt2, refs/stash, o/main, side, main, refs/custom/x)' +
            '|HEAD, tag: lt2, refs/stash, o/main, side, main, refs/custom/x' +
            '|<HEAD;T:lt2;refs/stash;o/main;side;main;refs/custom/x>]',
        });
      });
    });
  });
  describe('Given a commit signed with a canned OpenPGP signature', () => {
    const FORMAT = '[$Format:%G?|%GG|%GS|%GK|%GF|%GP|%GT$]';
    const signedRepo = async (slug: string): Promise<string> => {
      const dir = await makeSubstRepo(slug, { f: FORMAT });
      commitRaw(dir, `gpgsig ${continuationLines(ARMORED_SIGNATURE)}\n`, Buffer.from('signed\n'));
      return dir;
    };

    describe('When gpg.program names a missing binary', () => {
      it('Then the signature reads as N with empty fields and the archive is still produced', async () => {
        // Arrange
        const dir = await signedRepo('sig-missing');
        git(dir, 'config', 'gpg.program', path.join(dir, 'no-such-gpg'));

        // Act / Assert
        await expectSameExpansion(dir, 'HEAD', { f: '[N||||||undefined]' });
      });
    });

    describe('When the verifier prints no GOODSIG', () => {
      it('Then the signature reads as N and %GG carries the verifier stderr', async () => {
        // Arrange
        const dir = await signedRepo('sig-bad');
        const script = writeScript(
          dir,
          'fake-gpg',
          'cat >/dev/null\necho "verifier: no" >&2\nexit 1\n',
        );
        git(dir, 'config', 'gpg.program', script);

        // Act / Assert
        await expectSameExpansion(dir, 'HEAD', { f: '[N|verifier: no\n|||||undefined]' });
      });
    });

    describe('When symbolic links are planted at fixed staging names in the git dir', () => {
      it('Then their targets stay untouched and the verifier stderr still reaches %GG', async () => {
        // Arrange
        const dir = await signedRepo('sig-planted');
        const script = writeScript(
          dir,
          'fake-gpg',
          'cat >/dev/null\necho "verifier: no" >&2\nexit 1\n',
        );
        git(dir, 'config', 'gpg.program', script);
        const target = path.join(dir, 'precious');
        writeFileSync(target, 'precious\n');
        for (const name of ['GIT_VERIFY_BUFFER', 'GIT_VERIFY_BUFFER.err']) {
          symlinkSync(target, path.join(dir, '.git', name));
        }

        // Act / Assert
        await expectSameExpansion(dir, 'HEAD', { f: '[N|verifier: no\n|||||undefined]' });
        expect(readFileSync(target, 'utf8')).toBe('precious\n');
      });
    });

    describe('When the verifier reports a good signature', () => {
      it('Then every %G field reads the verifier status lines', async () => {
        // Arrange
        const dir = await signedRepo('sig-good');
        const script = writeScript(
          dir,
          'fake-gpg',
          [
            'cat >/dev/null',
            "echo '[GNUPG:] NEWSIG'",
            "echo '[GNUPG:] GOODSIG 0123456789ABCDEF Signer <signer@example.com>'",
            "echo '[GNUPG:] VALIDSIG AAAA 2023-11-14 1700000300 0 4 0 22 10 00 BBBB'",
            "echo '[GNUPG:] TRUST_FULLY 0 pgp'",
            'echo "gpg: Good signature" >&2',
            '',
          ].join('\n'),
        );
        git(dir, 'config', 'gpg.program', script);

        // Act / Assert
        await expectSameExpansion(dir, 'HEAD', {
          f: '[G|gpg: Good signature\n|Signer <signer@example.com>|0123456789ABCDEF|AAAA|BBBB|fully]',
        });
      });
    });
  });

  describe('Given a commit carrying both gpgsig and gpgsig-sha256 headers', () => {
    describe('When a verifier echoes the signature and payload it receives', () => {
      it('Then both tools hand it the same signature and payload', async () => {
        // Arrange
        const dir = await makeSubstRepo('sig-both', { f: '[$Format:%G?|%GG$]' });
        const other = ARMORED_SIGNATURE.replace('CANNED', 'OTHER');
        commitRaw(
          dir,
          `gpgsig ${continuationLines(ARMORED_SIGNATURE)}\ngpgsig-sha256 ${continuationLines(other)}\n`,
          Buffer.from('signed twice\n'),
        );
        const script = writeScript(
          dir,
          'echo-gpg',
          'for arg in "$@"; do [ "$arg" != - ] && [ -f "$arg" ] && cat "$arg" >&2; done\ncat >&2\nexit 1\n',
        );
        git(dir, 'config', 'gpg.program', script);

        // Act
        const result = await tsgitFiles(dir, 'HEAD');

        // Assert
        const expanded = gitFiles(dir, 'HEAD').get('f') ?? '';
        expect(expanded).toContain('CANNEDSIGNATUREBLOCK');
        expect(result.get('f')).toBe(expanded);
      });
    });
  });

  describe('Given a commit whose encoding header names a legacy charset', () => {
    const encodedRepo = async (
      slug: string,
      encoding: string,
      subject: Buffer,
    ): Promise<string> => {
      const dir = await makeSubstRepo(slug, {});
      writeLayout(dir, {
        subject: '[$Format:%e|%s$]',
        abbrev: 'pre-é [$Format:%h$] mid-é [$Format:%h$]',
        header: 'pre-é only\n[$Format:%e$]\n',
        cjk: 'pre-日本 only\n[$Format:%e$]\n',
      });
      commitRaw(dir, `encoding ${encoding}\n`, subject);
      return dir;
    };

    describe('When the encoding is ISO-8859-1', () => {
      it('Then expansions round-trip into the commit encoding and %h leaves the file alone', async () => {
        // Arrange
        const dir = await encodedRepo(
          'enc-latin1',
          'ISO-8859-1',
          Buffer.from('caf\xe9 subj\n', 'latin1'),
        );
        const short = head(dir).slice(0, 7);

        // Act / Assert
        await expectSameExpansion(dir, 'HEAD', {
          subject: '[ISO-8859-1|caf\xe9 subj]',
          abbrev: `pre-\xc3\xa9 [${short}] mid-\xc3\xa9 [${short}]`,
          header: 'pre-\xe9 only\n[ISO-8859-1]\n',
        });
      });
    });

    const utf16 = (text: string, order: 'utf16le' | 'ucs2be'): string =>
      order === 'utf16le'
        ? Buffer.from(text, 'utf16le').toString('latin1')
        : Buffer.from(text, 'utf16le').swap16().toString('latin1');

    describe.each([
      ['UTF-16', 'enc-utf16', 'header', `\xfe\xff${utf16('pre-é only\n[UTF-16', 'ucs2be')}]\n`],
      ['UTF-16LE', 'enc-utf16le', 'header', `${utf16('pre-é only\n[UTF-16LE', 'utf16le')}]\n`],
      ['ISO-2022-JP', 'enc-iso2022jp', 'cjk', 'pre-\u001b$BF|K\\\u001b(B only\n[ISO-2022-JP]\n'],
    ])('When the encoding is %s', (encoding, slug, file, expected) => {
      it('Then the buffer up to each header-parsing expansion is transcoded as git does', async () => {
        // Arrange
        const dir = await encodedRepo(slug, encoding, Buffer.from('subj\n'));

        // Act / Assert
        await expectSameExpansion(dir, 'HEAD', { [file]: expected });
      });
    });
  });

  describe('Given author and committer dates relative to a pinned clock', () => {
    // git reads its now from GIT_TEST_DATE_NOW; tsgit reads Date, faked to the same instant.
    const NOW_SECONDS = 1_700_000_000;
    const MILLISECONDS_PER_SECOND = 1000;

    afterEach(() => {
      vi.useRealTimers();
    });

    describe('When now-relative date modes expand', () => {
      it('Then %ar, %ah, %cr and %ch read the same clock as git', async () => {
        // Arrange
        const dir = await makeSubstRepo('relative', {});
        writeLayout(dir, { r: '[$Format:%ar|%ah|%cr|%ch$]' });
        commitAll(dir, 'relative\n', {
          GIT_AUTHOR_DATE: `${NOW_SECONDS - 25 * SECONDS_PER_HOUR} +0000`,
          GIT_COMMITTER_DATE: `${NOW_SECONDS - 2 * SECONDS_PER_HOUR} +0000`,
        });
        const expanded =
          gitFiles(dir, 'HEAD', { GIT_TEST_DATE_NOW: String(NOW_SECONDS) }).get('r') ?? '';
        vi.useFakeTimers({ toFake: ['Date'], now: NOW_SECONDS * MILLISECONDS_PER_SECOND });

        // Act
        const result = await tsgitFiles(dir, 'HEAD');

        // Assert
        expect(expanded).toBe('[25 hours ago|Mon 21:13|2 hours ago|2 hours ago]');
        expect(result.get('r')).toBe(expanded);
      });
    });
  });
  describe('Given an author date git cannot place on the calendar the usual way', () => {
    const DATE_PLACEHOLDERS = '[$Format:%ad|%aD|%ai|%aI|%as$]';
    const authored = async (date: string): Promise<string> => {
      const dir = await makeSubstRepo('odd-date', {});
      writeLayout(dir, { r: DATE_PLACEHOLDERS });
      commitRaw(dir, '', Buffer.from('odd\n'), {
        author: `A U Thor <author@example.com> ${date}`,
        committer: COMMITTER_IDENT,
      });
      return dir;
    };

    describe.each([
      [
        'a zone whose minutes exceed 59',
        '1700000200 +0099',
        '[Tue Nov 14 23:55:40 2023 +0099|Tue, 14 Nov 2023 23:55:40 +0099|2023-11-14 23:55:40 +0099|2023-11-14T23:55:40+00:99|2023-11-14]',
      ],
      [
        'a timestamp beyond the JavaScript Date range',
        '9007199254740991 -0075',
        '[Mon Nov 12 06:21:31 285428751 -0075|Mon, 12 Nov 285428751 06:21:31 -0075|285428751-11-12 06:21:31 -0075|285428751-11-12T06:21:31-00:75|285428751-11-12]',
      ],
      [
        'a four-digit zone far east of the date line',
        '4294967296 +9999',
        '[Thu Feb 11 11:07:16 2106 +9999|Thu, 11 Feb 2106 11:07:16 +9999|2106-02-11 11:07:16 +9999|2106-02-11T11:07:16+99:99|2106-02-11]',
      ],
    ])('When the author date is %s', (_title, date, expected) => {
      it('Then both tools expand the same bytes', async () => {
        // Arrange
        const dir = await authored(date);

        // Act / Assert
        await expectSameExpansion(dir, 'HEAD', { r: expected });
      });
    });

    describe('When the zone reaches back before the epoch', () => {
      it('Then both tools refuse with the same message', async () => {
        // Arrange
        const dir = await authored('0 -0075');

        // Act
        const result = await tsgitRefusal(dir, 'HEAD');

        // Assert
        expect(gitRefusal(dir, 'HEAD')).toEqual({
          exitCode: 128,
          stderr: 'fatal: Timestamp before Unix epoch: 0 -075\n',
        });
        expect(result.message).toBe('TIMESTAMP_OUT_OF_RANGE: Timestamp before Unix epoch: 0 -075');
      });
    });
  });

  describe('Given a borrower whose alternate multi-pack-index is unreadable', () => {
    const borrowerWith = async (files: Readonly<Record<string, string>>): Promise<string> => {
      const donor = await makeSubstRepo('refusal-donor', {});
      runGit(['-C', donor, 'repack', '-adq'], { env: substEnv() });
      writeMultiPackIndex(donor);
      const dir = `${donor}-borrower`;
      roots.push(dir);
      runGit(['clone', '-q', '--shared', donor, dir], { env: substEnv() });
      git(dir, 'config', 'commit.gpgSign', 'false');
      for (const [branch, content] of Object.entries(files)) {
        git(dir, 'checkout', '-q', '--orphan', branch);
        git(dir, 'rm', '-rqf', '.');
        // Own attribute bytes: a blob the donor already packed would be read from the broken source.
        writeLayout(dir, { '.gitattributes': 'f export-subst\n', f: content });
        commitAll(dir, `${branch}\n`);
      }
      mutateMidxOrThrow(
        path.join(donor, '.git', 'objects', 'pack', 'multi-pack-index'),
        (bytes) => {
          bytes.write('XXXX', 0, 'latin1');
          return bytes;
        },
      );
      return dir;
    };

    describe.each([
      ['an earlier occurrence', 'A=[$Format:%(count)$] B=[$Format:%h$]'],
      ['the same occurrence', 'A=[$Format:%(count)%h$]'],
    ])('When %(count) precedes %h in %s', (_where, content) => {
      it('Then both tools refuse at %(count)', async () => {
        // Arrange
        const dir = await borrowerWith({ refused: content });

        // Act
        const result = await tsgitRefusal(dir, 'refused');

        // Assert
        expect(gitRefusal(dir, 'refused')).toEqual({
          exitCode: 128,
          stderr: 'fatal: %(count) is not supported by this command\n',
        });
        expect(result.data).toEqual({
          code: 'FORMAT_PLACEHOLDER_UNSUPPORTED',
          placeholder: '%(count)',
          reason: 'not-supported',
        });
      });
    });

    describe.each([
      ['an earlier occurrence', 'B=[$Format:%h$] A=[$Format:%(count)$]'],
      ['the same occurrence', 'A=[$Format:%h%(count)$]'],
    ])('When %h precedes %(count) in %s', (_where, content) => {
      it('Then both tools refuse at the unreadable source', async () => {
        // Arrange
        const dir = await borrowerWith({ refused: content });

        // Act
        const result = await tsgitRefusal(dir, 'refused');

        // Assert
        const fromGit = gitRefusal(dir, 'refused');
        expect(fromGit.exitCode).toBe(128);
        expect(fromGit.stderr).toContain('multi-pack-index signature');
        expect(result.data).toMatchObject({ code: 'INVALID_MULTI_PACK_INDEX', check: 'signature' });
      });
    });
  });
  describe.skipIf(!GPG_AVAILABLE)('Given a commit signed by a real GnuPG key', () => {
    let gnupgHome = '';
    let previousGnupgHome: string | undefined;

    beforeAll(async () => {
      // GnuPG's agent socket path must stay under the UNIX-socket length limit.
      gnupgHome = await mkdtemp('/tmp/tsgit-subst-gnupg-');
      chmodSync(gnupgHome, 0o700);
      previousGnupgHome = process.env.GNUPGHOME;
      process.env.GNUPGHOME = gnupgHome;
    });

    afterAll(async () => {
      if (previousGnupgHome === undefined) delete process.env.GNUPGHOME;
      else process.env.GNUPGHOME = previousGnupgHome;
      await rm(gnupgHome, { recursive: true, force: true });
    });

    describe('When the signature placeholders expand', () => {
      it('Then both tools read the same verification result', async () => {
        // Arrange
        const gpgEnv = { ...process.env, GNUPGHOME: gnupgHome };
        execFileSync(
          'gpg',
          [
            '--batch',
            '--pinentry-mode',
            'loopback',
            '--passphrase',
            '',
            '--quick-generate-key',
          ].concat(['A U Thor <author@example.com>', 'ed25519', 'sign', 'never']),
          { env: gpgEnv, stdio: 'ignore' },
        );
        const fingerprint = execFileSync('gpg', ['--list-secret-keys', '--with-colons'], {
          env: gpgEnv,
        })
          .toString()
          .split('\n')
          .find((line) => line.startsWith('fpr:'))
          ?.split(':')[9];
        const dir = await makeSubstRepo('sig-gpg', { f: SIGNATURE_FORMAT });
        git(dir, 'config', 'user.signingKey', fingerprint ?? '');
        runGit(['-C', dir, 'commit', '-q', '-S', '--allow-empty', '-m', 'signed'], {
          env: substEnv({ GNUPGHOME: gnupgHome }),
        });

        // Act
        const result = await tsgitFiles(dir, 'HEAD');

        // Assert
        const fromGit = gitFiles(dir, 'HEAD', { GNUPGHOME: gnupgHome });
        expect(fromGit.get('f')).toMatch(/^\[G\|A U Thor <author@example.com>\|[0-9A-F]{16}\|/);
        expect(result).toEqual(fromGit);
      });
    });
  });

  describe.skipIf(!SSH_KEYGEN_AVAILABLE)('Given a commit signed by a real ssh key', () => {
    describe('When the signature placeholders expand', () => {
      it('Then both tools read the same verification result', async () => {
        // Arrange
        const dir = await makeSubstRepo('sig-ssh', { f: SIGNATURE_FORMAT });
        const key = path.join(dir, '.git', 'signing-key');
        execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'author', '-f', key]);
        const allowed = path.join(dir, '.git', 'allowed-signers');
        writeFileSync(allowed, `author@example.com ${readFileSync(`${key}.pub`, 'utf8')}`);
        git(dir, 'config', 'gpg.format', 'ssh');
        git(dir, 'config', 'user.signingKey', `${key}.pub`);
        git(dir, 'config', 'gpg.ssh.allowedSignersFile', allowed);
        runGit(['-C', dir, 'commit', '-q', '-S', '--allow-empty', '-m', 'signed'], {
          env: substEnv(),
        });

        // Act
        const result = await tsgitFiles(dir, 'HEAD');

        // Assert
        const fromGit = gitFiles(dir, 'HEAD');
        expect(fromGit.get('f')).toMatch(/^\[G\|author@example.com\|SHA256:/);
        expect(result).toEqual(fromGit);
      });
    });
  });
});
