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
import { hasObject } from '../../src/application/primitives/has-object.js';
import { readObjectMetadata } from '../../src/application/primitives/read-object.js';
import type { CatFileBatchEntry } from '../../src/application/primitives/types.js';
import type { DiffChange } from '../../src/domain/diff/diff-change.js';
import { TsgitError } from '../../src/domain/error.js';
import type { ObjectId, RefName } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  runGit,
  tryRunGitWithExit,
} from './interop-helpers.js';
import { mutateMidxOrThrow, writeMultiPackIndex } from './midx-fixture-helpers.js';
import { verifyPackRows, writeLooseObject } from './pack-fixture-helpers.js';

const SETUP_TIMEOUT = 120_000;
const ROW_TIMEOUT = 30_000;
const GIT_REFUSED = 128;
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
  commit(dir, 'c4');
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
          const resolved = await repo.revParse('HEAD:f');

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
