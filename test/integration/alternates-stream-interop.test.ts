/**
 * Cross-tool interop — the streamed open across alternate object stores. A
 * borrower whose only alternate cannot load (its multi-pack-index signature is
 * smashed) pins, per caller, whether the read reaches the alternate: git's
 * stream order (pack arm, loose arm, next source) refuses where its in-core
 * order is served by the primary. Both fixtures are built once by real git;
 * every row works on its own copies so the git and tsgit sides never share
 * mutable state.
 *
 * @proves
 *   surface:        packfile
 *   bucket:         cross-tool-interop
 *   unique:         tsgit opens blob streams across alternate object stores in git's stream order and refuses exactly where git dies
 *   interopSurface: packfile
 */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { push } from '../../src/application/commands/push.js';
import { buildPack } from '../../src/application/primitives/build-pack.js';
import { hasObject } from '../../src/application/primitives/has-object.js';
import { readObjectMetadata } from '../../src/application/primitives/read-object.js';
import type { CatFileBatchEntry } from '../../src/application/primitives/types.js';
import type { DiffChange } from '../../src/domain/diff/diff-change.js';
import { TsgitError, type TsgitErrorData } from '../../src/domain/error.js';
import type { ObjectId, RefName } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import { backendTransport } from './http-backend-transport.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  revParseStdout,
  runGit,
  tryRunGitWithExit,
} from './interop-helpers.js';
import { mutateMidxOrThrow, writeMultiPackIndex } from './midx-fixture-helpers.js';
import { verifyPackRows, writeLooseObject } from './pack-fixture-helpers.js';

const SETUP_TIMEOUT = 120_000;
const ROW_TIMEOUT = 30_000;
const GIT_REFUSED = 128;
const GIT_BUNDLE_REFUSED = 1;
const MIDX_SIGNATURE_FATAL =
  'multi-pack-index signature 0x58585858 does not match signature 0x4d494458';
const REFUSAL_DATA = { code: 'INVALID_MULTI_PACK_INDEX', check: 'signature' };
const SMALL = 'small\n';
const LOOSE_ONLY = 'aaa\n';
const SMALL_SIZE = 6;
const BELOW_SMALL = '5';
const AT_SMALL = '6';
const BELOW_ALL = '1';
const REFLOG = 'interop';
const LARGE_THRESHOLD = '1000';
const REGULAR = '100644';
const EXECUTABLE = '100755';
const SYMLINK = '120000';
const SUBTREE = '040000';
const BEHIND = 'behind';

let root: string;
let fixture: Fixture;
let copyCount = 0;

interface Fixture {
  readonly dir: string;
  readonly smallOid: string;
  readonly plainOid: string;
  readonly slimOid: string;
  readonly looseOid: string;
  readonly trees: ArchiveTrees;
}

interface ArchiveTrees {
  readonly refusing: string;
  readonly served: string;
  readonly exact: string;
  readonly link: string;
}

const hexLines = (count: number): string[] =>
  Array.from({ length: count }, (_, i) => `${i.toString(16).padStart(8, '0')}${'ab'.repeat(16)}\n`);

const commit = (dir: string, message: string): void => {
  runGit(['-C', dir, 'add', '-A']);
  runGit(['-C', dir, 'commit', '-q', '-m', message]);
};

const configureIdentity = (dir: string): void => {
  for (const [key, value] of [
    ['user.name', 'Ada'],
    ['user.email', 'ada@example.com'],
    ['commit.gpgSign', 'false'],
  ] as const) {
    runGit(['-C', dir, 'config', key, value]);
  }
  disableAutoMaintenance(dir);
};

const objectOf = (dir: string, rev: string): string => runGit(['-C', dir, 'rev-parse', rev]).trim();

const buildDonor = (): string => {
  const dir = path.join(root, 'donor');
  runGit(['init', '-q', '-b', 'main', dir]);
  configureIdentity(dir);
  writeFileSync(path.join(dir, 'd'), 'donor\n');
  commit(dir, 'c1');
  runGit(['-C', dir, 'repack', '-ad', '-q']);
  writeMultiPackIndex(dir);
  return dir;
};

const addBorrowerHistory = (dir: string): void => {
  const lines = hexLines(330);
  writeFileSync(path.join(dir, 'f'), SMALL);
  writeFileSync(path.join(dir, 'w'), 'a b\n');
  writeFileSync(path.join(dir, 'g'), 'one\n');
  writeFileSync(path.join(dir, 'plain'), lines.join(''));
  writeFileSync(path.join(dir, 'slim'), `${lines.slice(0, -1).join('')}changed\n`);
  symlinkSync('f', path.join(dir, 'lnk'));
  commit(dir, 'c2');
  writeFileSync(path.join(dir, 'w'), 'a  b\n');
  writeFileSync(path.join(dir, 'g'), 'two\n');
  commit(dir, 'c3');
};

const looseBytesOf = (content: string): Buffer =>
  deflateSync(
    Buffer.concat([Buffer.from(`blob ${Buffer.byteLength(content)}\0`), Buffer.from(content)]),
  );

const assertPackPrecondition = (dir: string, plainOid: string, slimOid: string): void => {
  const packDir = path.join(dir, '.git', 'objects', 'pack');
  const [idxName] = readdirSync(packDir).filter((name) => name.endsWith('.idx'));
  const rows = verifyPackRows(dir, path.join(packDir, idxName as string));
  expect(rows.find((row) => row.oid === plainOid)?.isDelta).toBe(false);
  expect(rows.find((row) => row.oid === slimOid)?.isDelta).toBe(true);
};

const mktree = (dir: string, rows: ReadonlyArray<readonly [string, string, string]>): string =>
  runGit(['-C', dir, 'mktree'], {
    input: rows
      .map(([mode, oid, name]) => `${mode} ${mode === SUBTREE ? 'tree' : 'blob'} ${oid}\t${name}\n`)
      .join(''),
  }).trim();

const buildArchiveTrees = (dir: string, plainOid: string, slimOid: string): ArchiveTrees => {
  const inner = mktree(dir, [[REGULAR, plainOid, 'x']]);
  return {
    refusing: mktree(dir, [
      [REGULAR, plainOid, 'a'],
      [SUBTREE, inner, 'alpha'],
      [REGULAR, slimOid, 'base'],
      [REGULAR, plainOid, 'z'],
    ]),
    served: mktree(dir, [
      [REGULAR, plainOid, 'plain'],
      [EXECUTABLE, plainOid, 'tool'],
    ]),
    exact: mktree(dir, [[REGULAR, slimOid, 'exact']]),
    link: mktree(dir, [[SYMLINK, slimOid, 'link']]),
  };
};

const stashNewFile = (dir: string): void => {
  writeFileSync(path.join(dir, 's'), 'stashed\n');
  runGit(['-C', dir, 'add', 's']);
  runGit(['-C', dir, 'stash', 'push', '-q']);
};

const buildBorrower = async (donor: string): Promise<Fixture> => {
  const dir = path.join(root, 'borrower');
  runGit(['clone', '-q', '--shared', donor, dir]);
  configureIdentity(dir);
  addBorrowerHistory(dir);
  writeFileSync(path.join(dir, 'a'), LOOSE_ONLY);
  runGit(['-C', dir, 'add', 'a']);
  const looseOid = objectOf(dir, ':a');
  const looseCopy = readFileSync(
    path.join(dir, '.git', 'objects', looseOid.slice(0, 2), looseOid.slice(2)),
  );
  writeFileSync(path.join(dir, 'w'), 'a   b\n');
  writeFileSync(path.join(dir, 'x'), 'exe\n', { mode: 0o755 });
  commit(dir, 'c4');
  stashNewFile(dir);
  runGit(['-C', dir, 'branch', BEHIND, 'HEAD~3']);
  runGit(['-C', dir, 'repack', '-ad', '-q']);
  await writeLooseObject(dir, looseOid, looseCopy);
  return {
    dir,
    smallOid: objectOf(dir, 'HEAD:f'),
    plainOid: objectOf(dir, 'HEAD:plain'),
    slimOid: objectOf(dir, 'HEAD:slim'),
    looseOid,
    trees: buildArchiveTrees(dir, objectOf(dir, 'HEAD:plain'), objectOf(dir, 'HEAD:slim')),
  };
};

beforeAll(async () => {
  if (!GIT_AVAILABLE) return;
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tsgit-interop-alt-stream-')));
  const donor = buildDonor();
  fixture = await buildBorrower(donor);
  assertPackPrecondition(fixture.dir, fixture.plainOid, fixture.slimOid);
  mutateMidxOrThrow(path.join(donor, '.git', 'objects', 'pack', 'multi-pack-index'), (bytes) => {
    bytes.write('XXXX', 0, 'latin1');
    return bytes;
  });
}, SETUP_TIMEOUT);

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// row helpers
// ---------------------------------------------------------------------------

interface Copy {
  readonly dir: string;
  readonly repo: () => Promise<Repository>;
}

const copyOfFixture = (): Copy => {
  copyCount += 1;
  const dir = path.join(root, `copy-${copyCount}`);
  cpSync(fixture.dir, dir, { recursive: true, verbatimSymlinks: true });
  return { dir, repo: () => openRepository({ cwd: dir }) };
};

const withThreshold = (threshold: string): Copy => {
  const copy = copyOfFixture();
  runGit(['-C', copy.dir, 'config', 'core.bigFileThreshold', threshold]);
  return copy;
};

const gitIn = (dir: string, ...args: ReadonlyArray<string>) =>
  tryRunGitWithExit(['-C', dir, ...args]);

const expectGitRefused = (result: { exitCode: number; stderr: string }): void => {
  expect(result.exitCode).toBe(GIT_REFUSED);
  expect(result.stderr).toContain(MIDX_SIGNATURE_FATAL);
};

const rejectionOf = async (action: () => Promise<unknown>): Promise<TsgitError> => {
  try {
    await action();
  } catch (error) {
    if (error instanceof TsgitError) return error;
    throw error;
  }
  return expect.fail('expected a TsgitError');
};

const drain = async (stream: AsyncIterable<Uint8Array>): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
};

const streamed = async (copy: Copy, oid: string): Promise<string> => {
  const repo = await copy.repo();
  try {
    return await drain(await repo.primitives.streamBlob(oid as ObjectId));
  } finally {
    await repo.dispose();
  }
};

const streamRefusal = async (copy: Copy, oid: string): Promise<TsgitError> => {
  const repo = await copy.repo();
  try {
    return await rejectionOf(async () => drain(await repo.primitives.streamBlob(oid as ObjectId)));
  } finally {
    await repo.dispose();
  }
};

const numstatPaths = (stdout: string): string[] =>
  stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t')[2] as string)
    .sort();

const pathOfChange = (change: DiffChange): string => {
  switch (change.type) {
    case 'add':
    case 'rename':
    case 'copy':
      return change.newPath;
    case 'delete':
      return change.oldPath;
    default:
      return change.path;
  }
};

const fileState = (dir: string, name: string): { mode: number; bytes: string } => {
  const file = path.join(dir, name);
  return {
    mode: lstatSync(file).mode & 0o777,
    bytes: lstatSync(file).isSymbolicLink() ? readlinkSync(file) : readFileSync(file, 'utf8'),
  };
};

// ---------------------------------------------------------------------------
// M5 rows
// ---------------------------------------------------------------------------

describe.skipIf(!GIT_AVAILABLE)('alternates stream interop — in-core readers', () => {
  describe('Given M5a: a small packed blob and an unusable alternate', () => {
    describe('When info and in-core reads run', () => {
      it(
        'Then both tools serve them from the primary pack',
        async () => {
          // Arrange
          const copy = copyOfFixture();
          const repo = await copy.repo();
          const oid = fixture.smallOid as ObjectId;

          // Act
          const type = await readObjectMetadata(repo.ctx, oid);
          const has = await hasObject(repo.ctx, oid);
          const resolved = revParseStdout(await repo.revParse('HEAD:f'));

          // Assert
          expect(gitIn(copy.dir, 'cat-file', '-t', oid).exitCode).toBe(0);
          expect(gitIn(copy.dir, 'rev-parse', 'HEAD:f').exitCode).toBe(0);
          expect(gitIn(copy.dir, 'cat-file', '--batch-check').exitCode).toBe(0);
          expect(type.type).toBe('blob');
          expect(has).toBe(true);
          expect(resolved).toBe(oid);
          await repo.dispose();
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given M5k: an unusable alternate', () => {
    describe('When diff ignores all whitespace', () => {
      it(
        'Then both tools succeed and name the same changed paths',
        async () => {
          // Arrange
          const copy = copyOfFixture();
          const repo = await copy.repo();

          // Act
          const result = await repo.diff({ from: 'HEAD~1', to: 'HEAD', ignoreWhitespace: 'all' });
          const git = gitIn(copy.dir, 'diff', '--stat', '-w', 'HEAD~1', 'HEAD');
          const numstat = gitIn(copy.dir, 'diff', '--numstat', '-w', 'HEAD~1', 'HEAD');

          // Assert
          expect(git.exitCode).toBe(0);
          expect(result.changes.map(pathOfChange).sort()).toEqual(numstatPaths(numstat.stdout));
          expect(numstat.exitCode).toBe(0);
          await repo.dispose();
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given M5m: an unusable alternate', () => {
    describe('When archive runs', () => {
      it(
        'Then both tools succeed and tsgit yields every entry',
        async () => {
          // Arrange
          const copy = copyOfFixture();
          const repo = await copy.repo();
          const expected = runGit(['-C', copy.dir, 'ls-tree', '-r', '--name-only', 'HEAD'])
            .split('\n')
            .filter(Boolean)
            .sort();

          // Act
          const { entries } = await repo.archive({ treeish: 'HEAD' });
          const paths: string[] = [];
          for await (const entry of entries) paths.push(entry.path);
          const git = gitIn(copy.dir, 'archive', 'HEAD');

          // Assert
          expect(git.exitCode).toBe(0);
          expect(paths.sort()).toEqual(expected);
          await repo.dispose();
        },
        ROW_TIMEOUT,
      );
    });
  });
});

describe.skipIf(!GIT_AVAILABLE)('alternates stream interop — streamBlob', () => {
  describe('Given M5b: a small packed blob, default threshold', () => {
    describe('When the blob is streamed', () => {
      it(
        'Then both tools refuse with the alternate midx error',
        async () => {
          // Arrange
          const copy = copyOfFixture();

          // Act
          const git = gitIn(copy.dir, 'cat-file', 'blob', fixture.smallOid);
          const result = await streamRefusal(copy, fixture.smallOid);

          // Assert
          expectGitRefused(git);
          expect(result.data).toMatchObject(REFUSAL_DATA);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given M5c: threshold below the blob size', () => {
    describe('When the blob is streamed', () => {
      it(
        'Then both tools serve the primary pack entry',
        async () => {
          // Arrange
          const copy = withThreshold(BELOW_SMALL);

          // Act
          const git = gitIn(copy.dir, 'cat-file', 'blob', fixture.smallOid);
          const result = await streamed(copy, fixture.smallOid);

          // Assert
          expect(git.exitCode).toBe(0);
          expect(git.stdout).toBe(SMALL);
          expect(result).toBe(SMALL);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given M5d: threshold equal to the blob size', () => {
    describe('When the blob is streamed', () => {
      it(
        'Then both tools decline the pack arm and refuse',
        async () => {
          // Arrange
          const copy = withThreshold(AT_SMALL);

          // Act
          const git = gitIn(copy.dir, 'cat-file', 'blob', fixture.smallOid);
          const result = await streamRefusal(copy, fixture.smallOid);

          // Assert
          expect(SMALL_SIZE).toBe(Number(AT_SMALL));
          expectGitRefused(git);
          expect(result.data).toMatchObject(REFUSAL_DATA);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given M5e: a non-delta pack entry above the threshold', () => {
    describe('When it is streamed', () => {
      it(
        'Then both tools serve it from the primary',
        async () => {
          // Arrange
          const copy = withThreshold(BELOW_ALL);

          // Act
          const git = gitIn(copy.dir, 'cat-file', 'blob', fixture.plainOid);
          const result = await streamed(copy, fixture.plainOid);

          // Assert
          expect(git.exitCode).toBe(0);
          expect(result).toBe(git.stdout);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given M5f: a delta pack entry above the threshold', () => {
    describe('When it is streamed', () => {
      it(
        'Then both tools decline the delta and refuse',
        async () => {
          // Arrange
          const copy = withThreshold(BELOW_ALL);

          // Act
          const git = gitIn(copy.dir, 'cat-file', 'blob', fixture.slimOid);
          const result = await streamRefusal(copy, fixture.slimOid);

          // Assert
          expectGitRefused(git);
          expect(result.data).toMatchObject(REFUSAL_DATA);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given M5l: the blob is also loose in the primary', () => {
    describe('When it is streamed and its file checked out', () => {
      it(
        'Then both tools serve the loose copy',
        async () => {
          // Arrange
          const gitSide = copyOfFixture();
          const tsgitSide = copyOfFixture();
          for (const copy of [gitSide, tsgitSide]) {
            await writeLooseObject(copy.dir, fixture.smallOid, looseBytesOf(SMALL));
            rmSync(path.join(copy.dir, 'f'));
          }
          const repo = await tsgitSide.repo();

          // Act
          const git = gitIn(gitSide.dir, 'cat-file', 'blob', fixture.smallOid);
          const gitCheckout = gitIn(gitSide.dir, 'checkout', '--', 'f');
          const result = await drain(
            await repo.primitives.streamBlob(fixture.smallOid as ObjectId),
          );
          await repo.checkout({ paths: ['f'] });

          // Assert
          expect(git.exitCode).toBe(0);
          expect(gitCheckout.exitCode).toBe(0);
          expect(result).toBe(SMALL);
          expect(fileState(tsgitSide.dir, 'f')).toEqual(fileState(gitSide.dir, 'f'));
          await repo.dispose();
        },
        ROW_TIMEOUT,
      );
    });
  });
});

describe.skipIf(!GIT_AVAILABLE)('alternates stream interop — ref targets and checkout', () => {
  describe('Given M5g: a small packed blob as ref target', () => {
    describe('When the ref is updated', () => {
      it(
        'Then both tools refuse and leave the ref absent',
        async () => {
          // Arrange
          const copy = copyOfFixture();
          const repo = await copy.repo();
          const name = 'refs/tags/tb';

          // Act
          const git = gitIn(copy.dir, 'update-ref', name, fixture.smallOid);
          const result = await rejectionOf(() =>
            repo.primitives.updateRef(name as RefName, fixture.smallOid as ObjectId, {
              reflogMessage: REFLOG,
            }),
          );

          // Assert
          expectGitRefused(git);
          expect(result.data).toMatchObject(REFUSAL_DATA);
          expect(gitIn(copy.dir, 'rev-parse', '--verify', '--quiet', name).exitCode).toBe(1);
          expect(existsSync(path.join(copy.dir, '.git', name))).toBe(false);
          await repo.dispose();
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given M5h: a commit as ref target', () => {
    describe('When the ref is updated', () => {
      it(
        'Then both tools succeed',
        async () => {
          // Arrange
          const copy = copyOfFixture();
          const repo = await copy.repo();
          const head = objectOf(copy.dir, 'HEAD');
          const name = 'refs/tags/tc' as RefName;

          // Act
          const git = gitIn(copy.dir, 'update-ref', name, 'HEAD');
          await repo.primitives.updateRef(name, head as ObjectId, { reflogMessage: REFLOG });

          // Assert
          expect(git.exitCode).toBe(0);
          expect(await repo.primitives.resolveRef(name)).toBe(head);
          await repo.dispose();
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given M5j: a deleted symlink', () => {
    describe('When it is checked out', () => {
      it(
        'Then both tools restore the link in-core',
        async () => {
          // Arrange
          const gitSide = copyOfFixture();
          const tsgitSide = copyOfFixture();
          for (const copy of [gitSide, tsgitSide]) rmSync(path.join(copy.dir, 'lnk'));
          const repo = await tsgitSide.repo();

          // Act
          const git = gitIn(gitSide.dir, 'checkout', '--', 'lnk');
          await repo.checkout({ paths: ['lnk'] });

          // Assert
          expect(git.exitCode).toBe(0);
          expect(fileState(tsgitSide.dir, 'lnk')).toEqual(fileState(gitSide.dir, 'lnk'));
          await repo.dispose();
        },
        ROW_TIMEOUT,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// M5n-M5s rows: cat-file --batch, show, archive
// ---------------------------------------------------------------------------

interface GitRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const gitWithInput = (dir: string, args: ReadonlyArray<string>, input: string): GitRun => {
  try {
    return { exitCode: 0, stdout: runGit(['-C', dir, ...args], { input }), stderr: '' };
  } catch (error) {
    const failure = error as { status: number; stdout: Buffer; stderr: Buffer };
    return {
      exitCode: failure.status,
      stdout: failure.stdout.toString(),
      stderr: failure.stderr.toString(),
    };
  }
};

const batchedRefusal = async (copy: Copy, oid: string): Promise<TsgitError> => {
  const repo = await copy.repo();
  try {
    return await rejectionOf(async () => {
      for await (const _entry of repo.primitives.catFileBatch([oid as ObjectId])) {
        // drain
      }
    });
  } finally {
    await repo.dispose();
  }
};

const archivePaths = async (
  copy: Copy,
  treeish: string,
): Promise<{ paths: string[]; contents: Map<string, string>; failure?: TsgitError }> => {
  const repo = await copy.repo();
  const paths: string[] = [];
  const contents = new Map<string, string>();
  try {
    const { entries } = await repo.archive({ treeish });
    for await (const entry of entries) {
      paths.push(entry.path);
      if ('content' in entry) contents.set(entry.path, Buffer.from(entry.content).toString('utf8'));
    }
    return { paths, contents };
  } catch (error) {
    if (!(error instanceof TsgitError)) throw error;
    return { paths, contents, failure: error };
  } finally {
    await repo.dispose();
  }
};

const worktreeText = (name: string): string => readFileSync(path.join(fixture.dir, name), 'utf8');

describe.skipIf(!GIT_AVAILABLE)('alternates stream interop — cat-file batch, show, archive', () => {
  describe('Given M5n: a small packed blob and an unusable alternate', () => {
    describe('When it is read through the batch reader', () => {
      it(
        'Then both tools refuse with the alternate midx error',
        async () => {
          // Arrange
          const copy = copyOfFixture();

          // Act
          const git = gitWithInput(copy.dir, ['cat-file', '--batch'], `${fixture.smallOid}\n`);
          const result = await batchedRefusal(copy, fixture.smallOid);

          // Assert
          expectGitRefused(git);
          expect(result.data).toMatchObject(REFUSAL_DATA);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given M5o: a commit and an unusable alternate', () => {
    describe('When it is read through the batch reader', () => {
      it(
        'Then both tools serve the same commit',
        async () => {
          // Arrange
          const copy = copyOfFixture();
          const repo = await copy.repo();
          const head = objectOf(copy.dir, 'HEAD');

          // Act
          const git = gitWithInput(copy.dir, ['cat-file', '--batch'], `${head}\n`);
          let entry: CatFileBatchEntry | undefined;
          for await (const item of repo.primitives.catFileBatch([head as ObjectId])) entry ??= item;

          // Assert
          expect(git.exitCode).toBe(0);
          expect(entry?.ok && entry.type).toBe('commit');
          expect(git.stdout.startsWith(`${head} commit `)).toBe(true);
          await repo.dispose();
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given M5p: a small packed blob and an unusable alternate', () => {
    describe('When show runs on the oid and on a path revision', () => {
      it(
        'Then both tools refuse with the alternate midx error each time',
        async () => {
          // Arrange
          const copy = copyOfFixture();
          const repo = await copy.repo();

          // Act
          const gitOid = gitIn(copy.dir, 'show', fixture.smallOid);
          const gitPath = gitIn(copy.dir, 'show', 'HEAD:f');
          const byOid = await rejectionOf(() => repo.show(fixture.smallOid));
          const byPath = await rejectionOf(() => repo.show('HEAD:f'));

          // Assert
          expectGitRefused(gitOid);
          expectGitRefused(gitPath);
          expect(byOid.data).toMatchObject(REFUSAL_DATA);
          expect(byPath.data).toMatchObject(REFUSAL_DATA);
          await repo.dispose();
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given M5q: a large delta blob named base after served entries and an unusable alternate', () => {
    describe('When archive runs', () => {
      it(
        'Then tsgit yields the entries before base and both tools refuse at base',
        async () => {
          // Arrange
          const copy = withThreshold(LARGE_THRESHOLD);
          const tree = fixture.trees.refusing;

          // Act
          const git = gitIn(copy.dir, 'archive', tree);
          const result = await archivePaths(copy, tree);

          // Assert
          expectGitRefused(git);
          expect(result.paths).toEqual(['a', 'alpha', 'alpha/x']);
          expect(result.failure?.data).toMatchObject(REFUSAL_DATA);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given M5r: large non-delta blobs, regular and executable, and an unusable alternate', () => {
    describe('When archive runs', () => {
      it(
        'Then both tools succeed and every entry equals the committed bytes',
        async () => {
          // Arrange
          const copy = withThreshold(LARGE_THRESHOLD);
          const tree = fixture.trees.served;

          // Act
          const git = gitIn(copy.dir, 'archive', tree);
          const result = await archivePaths(copy, tree);

          // Assert
          expect(git.exitCode).toBe(0);
          expect(result.failure).toBeUndefined();
          expect(result.paths).toEqual(['plain', 'tool']);
          for (const content of result.contents.values()) {
            expect(content).toBe(worktreeText('plain'));
          }
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given M5s: delta blobs read in the default order and an unusable alternate', () => {
    describe('When archive runs', () => {
      it(
        'Then both tools succeed and every entry equals the committed bytes',
        async () => {
          // Arrange
          const slimSize = worktreeText('slim').length;
          const atThreshold = withThreshold(String(slimSize));
          const aboveThreshold = withThreshold(LARGE_THRESHOLD);
          const { exact: exactTree, link: linkTree } = fixture.trees;

          // Act
          const gitExact = gitIn(atThreshold.dir, 'archive', exactTree);
          const gitLink = gitIn(aboveThreshold.dir, 'archive', linkTree);
          const exact = await archivePaths(atThreshold, exactTree);
          const link = await archivePaths(aboveThreshold, linkTree);

          // Assert
          expect(gitExact.exitCode).toBe(0);
          expect(gitLink.exitCode).toBe(0);
          expect(exact.failure).toBeUndefined();
          expect(link.failure).toBeUndefined();
          expect(exact.contents.get('exact')).toBe(worktreeText('slim'));
          expect(link.contents.get('link')).toBe(worktreeText('slim'));
        },
        ROW_TIMEOUT,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// M5u-M5w rows: pack builders refuse whenever any object source cannot load
// ---------------------------------------------------------------------------

const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(path.relative(dir, entry.parentPath), entry.name))
    .sort();

const SIGNATURE_REASON = /^invalid signature: expected (0x[0-9a-f]{8}), got (0x[0-9a-f]{8})$/;

/** git's gc child `fatal:` line, rebuilt from the task failure's signature refusal. */
const midxFatal = (data: TsgitErrorData | undefined): string | undefined => {
  if (data?.code !== 'INVALID_MULTI_PACK_INDEX') return undefined;
  const [, expected, found] = SIGNATURE_REASON.exec(data.reason) ?? [];
  return `fatal: multi-pack-index signature ${found} does not match signature ${expected}\n`;
};

const packDirOf = (dir: string): string => path.join(dir, '.git', 'objects', 'pack');
const objectsDirOf = (dir: string): string => path.join(dir, '.git', 'objects');

describe.skipIf(!GIT_AVAILABLE)('alternates stream interop — pack builders', () => {
  describe('Given M5u: an unusable alternate and an empty object list', () => {
    describe('When buildPack and packObjects run', () => {
      it(
        'Then both tools refuse and leave the pack directory untouched',
        async () => {
          // Arrange
          const gitCopy = copyOfFixture();
          const copy = copyOfFixture();
          const gitBefore = filesUnder(packDirOf(gitCopy.dir));
          const before = filesUnder(packDirOf(copy.dir));
          const repo = await copy.repo();

          // Act
          const gitBase = path.join(packDirOf(gitCopy.dir), 'pack');
          const gitEmpty = gitIn(gitCopy.dir, 'pack-objects', '--revs', gitBase);
          const git = tryRunGitWithExit(['-C', gitCopy.dir, 'pack-objects', '--revs', gitBase], {
            input: 'HEAD\n',
          });
          const built = await rejectionOf(() => buildPack(repo.ctx, { objects: [] }));
          const packed = await rejectionOf(() => repo.packObjects({ wants: ['HEAD'] }));
          await repo.dispose();

          // Assert
          expectGitRefused(gitEmpty);
          expectGitRefused(git);
          expect(filesUnder(packDirOf(gitCopy.dir))).toEqual(gitBefore);
          expect(built.data).toMatchObject(REFUSAL_DATA);
          expect(packed.data).toMatchObject(REFUSAL_DATA);
          expect(filesUnder(packDirOf(copy.dir))).toEqual(before);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given M5v: an unusable alternate', () => {
    describe('When bundle create runs', () => {
      it(
        'Then both tools refuse and write no bundle file',
        async () => {
          // Arrange
          const gitCopy = copyOfFixture();
          const copy = copyOfFixture();
          const bundleFile = path.join(root, `bundle-${copyCount}.bundle`);
          const repo = await copy.repo();

          // Act
          const git = gitIn(gitCopy.dir, 'bundle', 'create', bundleFile, 'HEAD');
          const refused = await rejectionOf(() => repo.bundle.create({ revs: [{ tip: 'HEAD' }] }));
          await repo.dispose();

          // Assert
          expect(git.exitCode).toBe(GIT_BUNDLE_REFUSED);
          expect(git.stderr).toContain(MIDX_SIGNATURE_FATAL);
          expect(existsSync(bundleFile)).toBe(false);
          expect(refused.data).toMatchObject(REFUSAL_DATA);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given M5w: an unusable alternate', () => {
    describe('When the gc task runs', () => {
      it(
        'Then both tools fail the task and leave the objects directory file set unchanged',
        async () => {
          // Arrange
          const gitCopy = copyOfFixture();
          const copy = copyOfFixture();
          const gitBefore = filesUnder(objectsDirOf(gitCopy.dir));
          const before = filesUnder(objectsDirOf(copy.dir));
          const repo = await copy.repo();

          // Act
          const git = gitIn(gitCopy.dir, 'maintenance', 'run', '--task=gc');
          const result = await repo.maintenance({ tasks: ['gc'] });
          await repo.dispose();

          // Assert
          expect(git.exitCode).toBe(1);
          expect(git.stderr).toContain(MIDX_SIGNATURE_FATAL);
          expect(git.stderr.endsWith("error: task 'gc' failed\n")).toBe(true);
          expect(filesUnder(objectsDirOf(gitCopy.dir))).toEqual(gitBefore);
          expect(result.tasksFailed.map(({ task }) => task)).toEqual(['gc']);
          expect(result.tasksFailed[0]?.data).toMatchObject(REFUSAL_DATA);
          expect(git.stderr).toContain(midxFatal(result.tasksFailed[0]?.data));
          expect(filesUnder(objectsDirOf(copy.dir))).toEqual(before);
        },
        ROW_TIMEOUT,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// M5ae-M5af rows: push sends a pack only when a command needs one
// ---------------------------------------------------------------------------

const PEER_URL = 'https://example.com/peer.git';
interface Peer {
  readonly root: string;
  readonly bare: string;
}

const makePeer = (): Peer => {
  copyCount += 1;
  const peerRoot = path.join(root, `peer-${copyCount}`);
  const bare = path.join(peerRoot, 'peer.git');
  runGit(['init', '-q', '--bare', '-b', 'main', bare]);
  configureIdentity(bare);
  runGit(['-C', bare, 'config', 'http.receivepack', 'true']);
  const tree = runGit(['-C', bare, 'mktree'], { input: '' }).trim();
  const tip = runGit(['-C', bare, 'commit-tree', tree, '-m', 'peer']).trim();
  runGit(['-C', bare, 'update-ref', 'refs/heads/x', tip]);
  return { root: peerRoot, bare };
};

const pushCopy = (): { copy: Copy; peer: Peer; gitCopy: Copy; gitPeer: Peer } => {
  const copy = copyOfFixture();
  const gitCopy = copyOfFixture();
  const peer = makePeer();
  const gitPeer = makePeer();
  for (const dir of [copy.dir, gitCopy.dir]) runGit(['-C', dir, 'branch', 'side', 'HEAD']);
  runGit(['-C', copy.dir, 'remote', 'set-url', 'origin', PEER_URL]);
  runGit(['-C', gitCopy.dir, 'remote', 'set-url', 'origin', gitPeer.bare]);
  return { copy, peer, gitCopy, gitPeer };
};

const refsOf = (bare: string): string =>
  runGit(['-C', bare, 'for-each-ref', '--format=%(refname)']).trim();

describe.skipIf(!GIT_AVAILABLE)('alternates stream interop — push', () => {
  describe('Given M5ae: an unusable alternate and a delete-only push', () => {
    describe('When push runs', () => {
      it(
        'Then both tools delete the remote ref without reading the object store',
        async () => {
          // Arrange
          const { copy, peer, gitCopy, gitPeer } = pushCopy();
          const repo = await copy.repo();

          // Act
          const git = gitIn(gitCopy.dir, 'push', 'origin', ':refs/heads/x');
          const result = await push(
            { ...repo.ctx, transport: backendTransport(peer.root) },
            { remote: 'origin', refspecs: [':refs/heads/x'] },
          );
          await repo.dispose();

          // Assert
          // git measures its status table's oid abbreviation after the wire
          // exchange, which loads the unusable alternate: it exits 128 once
          // the delete has landed. That is display only, so the row pins the
          // remote state both tools leave behind.
          expect(git.exitCode).toBe(GIT_REFUSED);
          expect(git.stderr).toContain(MIDX_SIGNATURE_FATAL);
          expect(result.pushedRefs[0]?.status).toBe('ok');
          expect(refsOf(gitPeer.bare)).toBe('');
          expect(refsOf(peer.bare)).toBe('');
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given M5af: an unusable alternate and a push that needs a pack', () => {
    describe('When push runs', () => {
      it(
        'Then both tools refuse and create no remote ref',
        async () => {
          // Arrange
          const { copy, peer, gitCopy, gitPeer } = pushCopy();
          const repo = await copy.repo();

          // Act
          const git = gitIn(gitCopy.dir, 'push', 'origin', 'side:refs/heads/y');
          const refused = await rejectionOf(() =>
            push(
              { ...repo.ctx, transport: backendTransport(peer.root) },
              { remote: 'origin', refspecs: ['side:refs/heads/y'] },
            ),
          );
          await repo.dispose();

          // Assert
          expect(git.exitCode).not.toBe(0);
          expect(refused.data).toMatchObject(REFUSAL_DATA);
          expect(refsOf(gitPeer.bare)).toBe('refs/heads/x');
          expect(refsOf(peer.bare)).toBe('refs/heads/x');
        },
        ROW_TIMEOUT,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// M5i, M5x-M5ab rows: a refused streamed worktree write leaves git's residue
// ---------------------------------------------------------------------------

interface Side {
  readonly git: Copy;
  readonly tsgit: Copy;
}

const sides = (prepare: (dir: string) => void = () => undefined): Side => {
  const side = { git: copyOfFixture(), tsgit: copyOfFixture() };
  for (const copy of [side.git, side.tsgit]) prepare(copy.dir);
  return side;
};

const removeFiles =
  (...names: ReadonlyArray<string>) =>
  (dir: string): void => {
    for (const name of names) rmSync(path.join(dir, name));
  };

const emptyState = { mode: 0o644, bytes: '' };

const listing = (dir: string): string[] =>
  readdirSync(dir)
    .filter((name) => name !== '.git')
    .sort()
    .map((name) => {
      const stat = lstatSync(path.join(dir, name));
      return `${name} ${stat.size} ${(stat.mode & 0o777).toString(8)}`;
    });

const indexOf = (dir: string): string => runGit(['-C', dir, 'ls-files', '-s']);

const headOf = (dir: string): string => runGit(['-C', dir, 'symbolic-ref', 'HEAD']).trim();

const hasIndexLock = (dir: string): boolean => existsSync(path.join(dir, '.git', 'index.lock'));

const expectUnrecorded = (dir: string, indexBefore: string): void => {
  expect(indexOf(dir)).toBe(indexBefore);
  expect(hasIndexLock(dir)).toBe(false);
};

const refusedCheckout = async (
  side: Side,
  gitArgs: ReadonlyArray<string>,
  options: Parameters<Repository['checkout']>[0],
): Promise<TsgitError> => {
  const git = gitIn(side.git.dir, ...gitArgs);
  const repo = await side.tsgit.repo();
  try {
    expectGitRefused(git);
    return await rejectionOf(() => repo.checkout(options));
  } finally {
    await repo.dispose();
  }
};

describe.skipIf(!GIT_AVAILABLE)('alternates stream interop — refused worktree writes', () => {
  describe('Given M5i: a deleted regular file whose blob only the unusable alternate path can serve', () => {
    describe('When it is checked out', () => {
      it(
        'Then both tools refuse and leave an empty file',
        async () => {
          // Arrange
          const side = sides(removeFiles('f'));

          // Act
          const result = await refusedCheckout(side, ['checkout', '--', 'f'], { paths: ['f'] });

          // Assert
          expect(result.data).toMatchObject(REFUSAL_DATA);
          expect(lstatSync(path.join(side.tsgit.dir, 'f')).size).toBe(0);
          expect(fileState(side.tsgit.dir, 'f')).toEqual(fileState(side.git.dir, 'f'));
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given M5x: a deleted regular file', () => {
    describe.each([
      ['the index', ['checkout', '--', 'f'], { paths: ['f'] }],
      ['HEAD', ['checkout', 'HEAD', '--', 'f'], { paths: ['f'], source: 'HEAD' }],
    ] as const)('When it is checked out from %s', (_source, gitArgs, options) => {
      it(
        'Then both tools leave an empty 0644 file, the index and no lock',
        async () => {
          // Arrange
          const side = sides(removeFiles('f'));
          const before = indexOf(side.tsgit.dir);

          // Act
          const result = await refusedCheckout(side, gitArgs, options);

          // Assert
          expect(result.data).toMatchObject(REFUSAL_DATA);
          expect(fileState(side.tsgit.dir, 'f')).toEqual(emptyState);
          expect(fileState(side.git.dir, 'f')).toEqual(emptyState);
          expectUnrecorded(side.tsgit.dir, before);
          expectUnrecorded(side.git.dir, before);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given M5y: a deleted executable file', () => {
    describe('When it is checked out', () => {
      it(
        'Then both tools leave an empty 0755 file',
        async () => {
          // Arrange
          const side = sides(removeFiles('x'));

          // Act
          const result = await refusedCheckout(side, ['checkout', '--', 'x'], { paths: ['x'] });

          // Assert
          expect(result.data).toMatchObject(REFUSAL_DATA);
          expect(fileState(side.tsgit.dir, 'x')).toEqual({ mode: 0o755, bytes: '' });
          expect(fileState(side.git.dir, 'x')).toEqual({ mode: 0o755, bytes: '' });
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given M5z: several paths to restore', () => {
    describe.each([
      ['a loose-only file and a packed one are deleted', removeFiles('a', 'f')],
      [
        'a packed one is modified',
        (dir: string) => writeFileSync(path.join(dir, 'f'), 'modified\n'),
      ],
    ] as const)('When %s and both are checked out', (_case, prepare) => {
      it(
        'Then both tools restore what the loose arm serves and empty the refused one',
        async () => {
          // Arrange
          const side = sides(prepare);
          const paths = ['a', 'f'];

          // Act
          const result = await refusedCheckout(side, ['checkout', '--', ...paths], { paths });

          // Assert
          expect(result.data).toMatchObject(REFUSAL_DATA);
          expect(listing(side.tsgit.dir)).toEqual(listing(side.git.dir));
          expect(fileState(side.tsgit.dir, 'f')).toEqual(emptyState);
          expect(fileState(side.tsgit.dir, 'a').bytes).toBe(LOOSE_ONLY);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given M5aa: an attached branch behind main with a worktree at its commit', () => {
    const behindSide = (): Side =>
      sides((dir) => {
        for (const name of readdirSync(dir)) {
          if (name !== '.git' && name !== 'd') rmSync(path.join(dir, name), { force: true });
        }
        runGit(['-C', dir, 'symbolic-ref', 'HEAD', `refs/heads/${BEHIND}`]);
        runGit(['-C', dir, 'read-tree', BEHIND]);
      });

    const expectSameResidue = (side: Side, before: string): void => {
      expect(listing(side.tsgit.dir)).toEqual(listing(side.git.dir));
      expect(headOf(side.tsgit.dir)).toBe(headOf(side.git.dir));
      expect(objectOf(side.tsgit.dir, BEHIND)).toBe(objectOf(side.git.dir, BEHIND));
      expectUnrecorded(side.tsgit.dir, before);
      expectUnrecorded(side.git.dir, before);
    };

    describe('When main is checked out', () => {
      it(
        'Then both tools leave the same worktree and keep HEAD, branch and index',
        async () => {
          // Arrange
          const side = behindSide();
          const before = indexOf(side.tsgit.dir);

          // Act
          const result = await refusedCheckout(side, ['checkout', 'main'], { rev: 'main' });

          // Assert
          expect(result.data).toMatchObject(REFUSAL_DATA);
          expectSameResidue(side, before);
        },
        ROW_TIMEOUT,
      );
    });

    describe('When the worktree is hard reset to main', () => {
      it(
        'Then both tools leave the same worktree and keep HEAD, branch and index',
        async () => {
          // Arrange
          const side = behindSide();
          const before = indexOf(side.tsgit.dir);
          const git = gitIn(side.git.dir, 'reset', '--hard', 'main');
          const repo = await side.tsgit.repo();

          // Act
          const result = await rejectionOf(() => repo.reset({ mode: 'hard', rev: 'main' }));
          await repo.dispose();

          // Assert
          expectGitRefused(git);
          expect(result.data).toMatchObject(REFUSAL_DATA);
          expectSameResidue(side, before);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given M5ab: a stash adding a packed file', () => {
    describe('When the stash is applied', () => {
      it(
        'Then both tools leave an empty file and keep HEAD and index',
        async () => {
          // Arrange
          const side = sides();
          const before = indexOf(side.tsgit.dir);
          const git = gitIn(side.git.dir, 'stash', 'apply');
          const repo = await side.tsgit.repo();

          // Act
          const result = await rejectionOf(() => repo.stash.apply());
          await repo.dispose();

          // Assert
          expectGitRefused(git);
          expect(result.data).toMatchObject(REFUSAL_DATA);
          expect(fileState(side.tsgit.dir, 's')).toEqual(emptyState);
          expect(fileState(side.git.dir, 's')).toEqual(emptyState);
          expectUnrecorded(side.tsgit.dir, before);
          expect(objectOf(side.tsgit.dir, 'HEAD')).toBe(objectOf(side.git.dir, 'HEAD'));
        },
        ROW_TIMEOUT,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// M5ac-M5ad rows: history-rewriting commands refuse before writing anything
// ---------------------------------------------------------------------------

const GIT_STATE_FILES = [
  'ORIG_HEAD',
  'MERGE_HEAD',
  'MERGE_MSG',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'sequencer',
  'rebase-merge',
  'rebase-apply',
] as const;

const gitStateOf = (dir: string): Record<string, string | null> => {
  const gitDir = path.join(dir, '.git');
  const entries = GIT_STATE_FILES.map((name) => {
    const file = path.join(gitDir, name);
    return [name, existsSync(file) ? readFileSync(file).toString('utf8') : null] as const;
  });
  return Object.fromEntries(entries);
};

const writeState = (dir: string): string[] => [
  readFileSync(path.join(dir, '.git', 'HEAD'), 'utf8'),
  indexOf(dir),
  ...listing(dir),
];

const atBehindWorktree = (dir: string, head: () => void): void => {
  for (const name of readdirSync(dir)) {
    if (name !== '.git' && name !== 'd') rmSync(path.join(dir, name), { force: true });
  }
  head();
  runGit(['-C', dir, 'read-tree', BEHIND]);
};

describe.skipIf(!GIT_AVAILABLE)('alternates stream interop — refused history commands', () => {
  describe('Given M5ac: an attached branch behind main', () => {
    const attachedBehind = (): Side =>
      sides((dir) =>
        atBehindWorktree(dir, () =>
          runGit(['-C', dir, 'symbolic-ref', 'HEAD', `refs/heads/${BEHIND}`]),
        ),
      );

    const expectSameRefusal = (side: Side, before: string[], origHead: string | null): void => {
      expect(gitStateOf(side.tsgit.dir)).toEqual(gitStateOf(side.git.dir));
      expect(gitStateOf(side.tsgit.dir).ORIG_HEAD).toBe(origHead);
      expect(writeState(side.tsgit.dir)).toEqual(before);
      expect(writeState(side.git.dir)).toEqual(before);
      expect(hasIndexLock(side.tsgit.dir)).toBe(false);
    };

    describe.each([
      ['merge', ['merge', 'main'], 'allow'],
      ['merge --no-ff', ['merge', '--no-ff', 'main'], 'never'],
      ['merge --ff-only', ['merge', '--ff-only', 'main'], 'only'],
    ] as const)('When %s targets main', (_label, gitArgs, fastForward) => {
      it(
        'Then both tools refuse, write ORIG_HEAD and nothing else',
        async () => {
          // Arrange
          const side = attachedBehind();
          const before = writeState(side.tsgit.dir);
          const git = gitIn(side.git.dir, ...gitArgs);
          const repo = await side.tsgit.repo();

          // Act
          const result = await rejectionOf(() => repo.merge.run({ rev: 'main', fastForward }));
          await repo.dispose();

          // Assert
          expectGitRefused(git);
          expect(result.data).toMatchObject(REFUSAL_DATA);
          expectSameRefusal(side, before, `${objectOf(side.tsgit.dir, BEHIND)}\n`);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given M5ac: HEAD on main', () => {
    describe.each([
      [
        'cherryPick',
        () => ['cherry-pick', BEHIND],
        (repo: Repository) => repo.cherryPick.run({ commits: [BEHIND] }),
      ],
      [
        'revert',
        () => ['revert', 'HEAD'],
        (repo: Repository) => repo.revert.run({ commits: ['HEAD'] }),
      ],
      [
        'rebase',
        (parent: string) => ['rebase', '--onto', BEHIND, parent],
        (repo: Repository, parent: string) => repo.rebase.run({ upstream: parent, onto: BEHIND }),
      ],
    ] as const)('When %s runs', (_label, gitArgs, run) => {
      it(
        'Then both tools refuse and leave the same state',
        async () => {
          // Arrange
          const side = sides();
          const before = writeState(side.tsgit.dir);
          const parent = objectOf(side.git.dir, 'main~1');
          const git = gitIn(side.git.dir, ...gitArgs(parent));
          const repo = await side.tsgit.repo();

          // Act
          const result = await rejectionOf(() => run(repo, parent));
          await repo.dispose();

          // Assert
          expectGitRefused(git);
          expect(result.data).toMatchObject(REFUSAL_DATA);
          expect(gitStateOf(side.tsgit.dir)).toEqual(gitStateOf(side.git.dir));
          expect(writeState(side.tsgit.dir)).toEqual(before);
          expect(writeState(side.git.dir)).toEqual(before);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given M5ad: a detached HEAD at the first commit', () => {
    const detachedBehind = (): Side =>
      sides((dir) =>
        atBehindWorktree(dir, () =>
          runGit(['-C', dir, 'update-ref', '--no-deref', 'HEAD', objectOf(dir, BEHIND)]),
        ),
      );

    describe('When main is checked out', () => {
      it(
        'Then both tools refuse and keep HEAD, index and worktree',
        async () => {
          // Arrange
          const side = detachedBehind();
          const before = writeState(side.tsgit.dir);

          // Act
          const result = await refusedCheckout(side, ['checkout', 'main'], { rev: 'main' });

          // Assert
          expect(result.data).toMatchObject(REFUSAL_DATA);
          expect(writeState(side.tsgit.dir)).toEqual(before);
          expect(writeState(side.git.dir)).toEqual(before);
        },
        ROW_TIMEOUT,
      );
    });

    describe('When a commit is cherry-picked', () => {
      it(
        'Then both tools refuse and leave the same state',
        async () => {
          // Arrange
          const side = detachedBehind();
          const before = writeState(side.tsgit.dir);
          const git = gitIn(side.git.dir, 'cherry-pick', 'main');
          const repo = await side.tsgit.repo();

          // Act
          const result = await rejectionOf(() => repo.cherryPick.run({ commits: ['main'] }));
          await repo.dispose();

          // Assert
          expectGitRefused(git);
          expect(result.data).toMatchObject(REFUSAL_DATA);
          expect(gitStateOf(side.tsgit.dir)).toEqual(gitStateOf(side.git.dir));
          expect(writeState(side.tsgit.dir)).toEqual(before);
        },
        ROW_TIMEOUT,
      );
    });

    describe('When merge runs', () => {
      it(
        'Then tsgit refuses as unsupported and keeps its state (git refuses on the object source)',
        async () => {
          // Arrange
          const side = detachedBehind();
          const before = writeState(side.tsgit.dir);
          const stateBefore = gitStateOf(side.tsgit.dir);
          const repo = await side.tsgit.repo();

          // Act
          const result = await rejectionOf(() => repo.merge.run({ rev: 'main' }));
          await repo.dispose();

          // Assert
          expect(result.data).toMatchObject({ code: 'UNSUPPORTED_OPERATION', operation: 'merge' });
          expect(writeState(side.tsgit.dir)).toEqual(before);
          expect(gitStateOf(side.tsgit.dir)).toEqual(stateBefore);
        },
        ROW_TIMEOUT,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Sequencer commands refuse on an unusable source only where git reads it
// ---------------------------------------------------------------------------

const GIT_NO_OPERATION = 128;

describe.skipIf(!GIT_AVAILABLE)('alternates stream interop — sequencer no-op paths', () => {
  describe('Given HEAD on main and nothing to rebase', () => {
    describe.each([
      ['rebase main', ['rebase', 'main'], { upstream: 'main' }],
      ['rebase HEAD', ['rebase', 'HEAD'], { upstream: 'HEAD' }],
      [
        'rebase --onto main main',
        ['rebase', '--onto', 'main', 'main'],
        { upstream: 'main', onto: 'main' },
      ],
      [
        'rebase --onto HEAD HEAD',
        ['rebase', '--onto', 'HEAD', 'HEAD'],
        { upstream: 'HEAD', onto: 'HEAD' },
      ],
    ] as const)('When %s runs', (_label, gitArgs, input) => {
      it(
        'Then both tools succeed as up to date and leave the same state',
        async () => {
          // Arrange
          const side = sides();
          const before = writeState(side.tsgit.dir);
          const git = gitIn(side.git.dir, ...gitArgs);
          const repo = await side.tsgit.repo();

          // Act
          const result = await repo.rebase.run(input);
          await repo.dispose();

          // Assert
          expect(git.exitCode).toBe(0);
          expect(result).toEqual({ kind: 'up-to-date' });
          expect(gitStateOf(side.tsgit.dir)).toEqual(gitStateOf(side.git.dir));
          expect(writeState(side.tsgit.dir)).toEqual(before);
          expect(writeState(side.git.dir)).toEqual(before);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given no operation in progress', () => {
    describe.each([
      [
        'rebase --continue',
        ['rebase', '--continue'],
        (r: Repository) => r.rebase.continue(),
        'rebase',
      ],
      ['rebase --skip', ['rebase', '--skip'], (r: Repository) => r.rebase.skip(), 'rebase'],
      ['rebase --abort', ['rebase', '--abort'], (r: Repository) => r.rebase.abort(), 'rebase'],
      [
        'cherry-pick --continue',
        ['cherry-pick', '--continue'],
        (r: Repository) => r.cherryPick.continue(),
        'cherry-pick',
      ],
      [
        'cherry-pick --skip',
        ['cherry-pick', '--skip'],
        (r: Repository) => r.cherryPick.skip(),
        'cherry-pick',
      ],
      [
        'revert --continue',
        ['revert', '--continue'],
        (r: Repository) => r.revert.continue(),
        'revert',
      ],
      ['revert --skip', ['revert', '--skip'], (r: Repository) => r.revert.skip(), 'revert'],
    ] as const)('When %s runs', (_label, gitArgs, run, operation) => {
      it(
        'Then both tools report nothing in progress rather than the object source',
        async () => {
          // Arrange
          const side = sides();
          const before = writeState(side.tsgit.dir);
          const git = gitIn(side.git.dir, ...gitArgs);
          const repo = await side.tsgit.repo();

          // Act
          const result = await rejectionOf(() => run(repo));
          await repo.dispose();

          // Assert
          expect(git.exitCode).toBe(GIT_NO_OPERATION);
          expect(git.stderr).not.toContain(MIDX_SIGNATURE_FATAL);
          expect(result.data).toMatchObject({ code: 'NO_OPERATION_IN_PROGRESS', operation });
          expect(writeState(side.tsgit.dir)).toEqual(before);
        },
        ROW_TIMEOUT,
      );
    });
  });
});
