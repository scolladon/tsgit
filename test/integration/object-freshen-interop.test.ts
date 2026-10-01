/**
 * Cross-tool interop — writing an object another copy already holds. Each row
 * builds the same borrower/donor pair twice, runs the same write on real git
 * (`hash-object -w` / `commit-tree` / `fetch`) and on tsgit, and compares what
 * is left behind: the object set held by the borrower's own store, the set of
 * files whose mtime moved, and `git fsck`. Row ids follow git's `odb_freshen_object`
 * contract: a held copy is touched instead of rewritten, packs before loose
 * within a store, and a refused touch moves on to the next store.
 *
 * @proves
 *   surface:        objectFreshen
 *   bucket:         cross-tool-interop
 *   unique:         tsgit leaves the same objects on disk and touches the same files as git when the written object is already held by the store or an alternate
 *   interopSurface: objectFreshen
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { TsgitError } from '../../src/domain/error.js';
import type { Commit, ObjectId } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import { findGitHttpBackend, startGitHttpBackend } from '../bench/support/http-backend-server.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  gitAsync,
  runGit,
  runGitEnv,
  tryRunGitWithExit,
} from './interop-helpers.js';
import { writeMultiPackIndex } from './midx-fixture-helpers.js';

const SETUP_TIMEOUT = 120_000;
const ROW_TIMEOUT = 60_000;
const DARWIN = process.platform === 'darwin';
const BACKDATED = new Date('2001-01-01T00:00:00Z');
const MOVED_AFTER_MS = BACKDATED.getTime() + 86_400_000;
const MIDX_SIGNATURE_FATAL =
  'multi-pack-index signature 0x58585858 does not match signature 0x4d494458';
const SUBJECT = 'freshen subject\n';
const COMMIT_DATE = '2001-02-03T04:05:06+0000';
const COMMIT_TIMESTAMP = 981173106;

let root: string;
const lockedPaths: string[] = [];

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tsgit-interop-freshen-')));
});

afterEach(() => {
  for (const locked of lockedPaths.splice(0)) execFileSync('chflags', ['nouchg', locked]);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------

interface Repo {
  readonly dir: string;
  readonly objects: string;
}

interface Side {
  readonly root: string;
  readonly donor: Repo;
  readonly borrower: Repo;
}

const commitEnv = (): NodeJS.ProcessEnv => ({
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_AUTHOR_DATE: COMMIT_DATE,
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
  GIT_COMMITTER_DATE: COMMIT_DATE,
});

const initWorktree = (dir: string): Repo => {
  runGit(['init', '-q', '-b', 'main', dir]);
  for (const [key, value] of [
    ['user.name', 'Ada'],
    ['user.email', 'ada@example.com'],
    ['commit.gpgSign', 'false'],
    ['tag.gpgSign', 'false'],
  ] as const) {
    runGit(['-C', dir, 'config', key, value]);
  }
  disableAutoMaintenance(dir);
  return { dir, objects: path.join(dir, '.git', 'objects') };
};

const writeAlternates = (borrower: Repo, donor: Repo): void => {
  mkdirSync(path.join(borrower.objects, 'info'), { recursive: true });
  writeFileSync(path.join(borrower.objects, 'info', 'alternates'), `${donor.objects}\n`);
};

const makeSide = (rowId: string, peer: string): Side => {
  const sideRoot = path.join(root, rowId, peer);
  const donor = initWorktree(path.join(sideRoot, 'donor'));
  const borrower = initWorktree(path.join(sideRoot, 'borrower'));
  writeAlternates(borrower, donor);
  return { root: sideRoot, donor, borrower };
};

const blobIn = (repo: Repo, content: string): string =>
  runGit(['-C', repo.dir, 'hash-object', '-w', '--stdin'], { input: content }).trim();

const commitIn = (repo: Repo, content: string, file = 'f.txt'): void => {
  writeFileSync(path.join(repo.dir, file), content);
  runGit(['-C', repo.dir, 'add', file]);
  runGit(['-C', repo.dir, 'commit', '-q', '-m', `add ${file}`], { env: commitEnv() });
};

const repackAll = (repo: Repo, ...flags: ReadonlyArray<string>): void => {
  runGit(['-C', repo.dir, 'repack', '-q', ...flags]);
};

const packFiles = (repo: Repo, extension: string): ReadonlyArray<string> =>
  readdirSync(path.join(repo.objects, 'pack'))
    .filter((name) => name.endsWith(extension))
    .map((name) => path.join(repo.objects, 'pack', name));

const loosePath = (repo: Repo, id: string): string =>
  path.join(repo.objects, id.slice(0, 2), id.slice(2));

const smashMidxSignature = (repo: Repo): void => {
  const midx = path.join(repo.objects, 'pack', 'multi-pack-index');
  const bytes = readFileSync(midx);
  bytes.set(Buffer.from('XXXX'), 0);
  writeFileSync(midx, bytes);
};

const walkFiles = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walkFiles(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
  );

const backdate = (side: Side): ReadonlyArray<string> => {
  const files = walkFiles(side.root);
  for (const file of files) utimesSync(file, BACKDATED, BACKDATED);
  return files.map((file) => path.relative(side.root, file));
};

const lock = (file: string): void => {
  execFileSync('chflags', ['uchg', file]);
  lockedPaths.push(file);
};

/** Pack names derive from a hash of the pack bytes; a row compares the file's role, not its name. */
const roleOf = (relative: string): string => relative.replace(/pack-[0-9a-f]{40}/, 'pack-HASH');

const movedFiles = (side: Side): ReadonlyArray<string> =>
  walkFiles(side.root)
    .filter((file) => statSync(file).mtimeMs > MOVED_AFTER_MS)
    .map((file) => path.relative(side.root, file));

const primaryObjects = (repo: Repo): ReadonlyArray<string> => {
  const loose = readdirSync(repo.objects)
    .filter((name) => /^[0-9a-f]{2}$/.test(name))
    .flatMap((prefix) =>
      readdirSync(path.join(repo.objects, prefix)).map((suffix) => `${prefix}${suffix}`),
    );
  const packed = packFiles(repo, '.idx').flatMap((idx) =>
    runGit(['show-index'], { input: readFileSync(idx) })
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => line.split(' ')[1] as string),
  );
  return [...new Set([...loose, ...packed])].sort();
};

const blobObject = (content: string) =>
  ({ type: 'blob', content: new TextEncoder().encode(content), id: '' as ObjectId }) as const;

const commitObject = (tree: string): Commit => {
  const identity = {
    name: 'Ada',
    email: 'ada@example.com',
    timestamp: COMMIT_TIMESTAMP,
    timezoneOffset: '+0000',
  };
  return {
    type: 'commit',
    id: '' as ObjectId,
    data: {
      tree: tree as ObjectId,
      parents: [],
      author: identity,
      committer: identity,
      message: 'm\n',
      extraHeaders: [],
    },
  };
};

// ---------------------------------------------------------------------------
// rows
// ---------------------------------------------------------------------------

interface Row {
  readonly id: string;
  readonly title: string;
  readonly darwinOnly?: true;
  readonly write: 'blob' | 'commit-of-donor-tree' | 'new-blob';
  readonly refusedBy?: 'midx-signature';
  /** Builds one peer's pair; returns the files to make immutable once back-dated. */
  readonly build: (side: Side) => ReadonlyArray<string>;
  /** Pre-existing files the write must touch. */
  readonly touched: (side: Side) => ReadonlyArray<string>;
  /** How many files the write must create. */
  readonly created: number;
}

const SUBJECT_ID = runGit(['hash-object', '--stdin'], { input: SUBJECT }).trim();

const donorLoose = (side: Side): void => void blobIn(side.donor, SUBJECT);
const borrowerLoose = (side: Side): void => void blobIn(side.borrower, SUBJECT);

const packed = (repo: Repo): void => {
  commitIn(repo, SUBJECT);
  repackAll(repo, '-ad');
};

const looseAndPacked = (repo: Repo): void => {
  commitIn(repo, SUBJECT);
  repackAll(repo, '-a');
};

const midxDonor = (side: Side): void => {
  commitIn(side.donor, 'first pack filler\n', 'a.txt');
  repackAll(side.donor, '-ad');
  commitIn(side.donor, SUBJECT, 'b.txt');
  repackAll(side.donor, '-d');
  writeMultiPackIndex(side.donor.dir);
};

const cruftBorrower = (side: Side): void => {
  commitIn(side.borrower, 'reachable filler\n', 'a.txt');
  repackAll(side.borrower, '-ad');
  blobIn(side.borrower, SUBJECT);
  repackAll(side.borrower, '--cruft', '-d');
};

const sole = (files: ReadonlyArray<string>): string => files[0] as string;
const packOf = (repo: Repo): string => sole(packFiles(repo, '.pack'));
const nothing = (): ReadonlyArray<string> => [];

const ROWS: ReadonlyArray<Row> = [
  {
    id: 'W1',
    title: 'the donor holds the object loose',
    write: 'blob',
    build: (side) => {
      donorLoose(side);
      return [];
    },
    touched: (side) => [loosePath(side.donor, SUBJECT_ID)],
    created: 0,
  },
  {
    id: 'W2',
    title: 'the donor holds the object packed',
    write: 'blob',
    build: (side) => {
      packed(side.donor);
      return [];
    },
    touched: (side) => [packOf(side.donor)],
    created: 0,
  },
  {
    id: 'W2m',
    title: 'the donor holds the object in a pack covered by a multi-pack-index',
    write: 'blob',
    build: (side) => {
      midxDonor(side);
      return [];
    },
    touched: (side) => [
      sole(packFiles(side.donor, '.pack').filter((pack) => holds(pack, SUBJECT_ID))),
    ],
    created: 0,
  },
  {
    id: 'W2b',
    title: 'the donor pack holding the object is immutable',
    darwinOnly: true,
    write: 'blob',
    build: (side) => {
      packed(side.donor);
      return [packOf(side.donor)];
    },
    touched: nothing,
    created: 1,
  },
  {
    id: 'W3',
    title: 'the donor loose object is immutable',
    darwinOnly: true,
    write: 'blob',
    build: (side) => {
      donorLoose(side);
      return [loosePath(side.donor, SUBJECT_ID)];
    },
    touched: nothing,
    created: 1,
  },
  {
    id: 'W4',
    title: 'a commit is written over the donor tree',
    write: 'commit-of-donor-tree',
    build: (side) => {
      commitIn(side.donor, SUBJECT);
      return [];
    },
    touched: nothing,
    created: 1,
  },
  {
    id: 'W5',
    title: 'the donor multi-pack-index signature is smashed and a new object is written',
    write: 'new-blob',
    refusedBy: 'midx-signature',
    build: (side) => {
      midxDonor(side);
      smashMidxSignature(side.donor);
      return [];
    },
    touched: nothing,
    created: 0,
  },
  {
    id: 'WP1',
    title: 'the borrower holds the object loose',
    write: 'blob',
    build: (side) => {
      borrowerLoose(side);
      return [];
    },
    touched: (side) => [loosePath(side.borrower, SUBJECT_ID)],
    created: 0,
  },
  {
    id: 'WP2',
    title: 'the borrower holds the object packed',
    write: 'blob',
    build: (side) => {
      packed(side.borrower);
      return [];
    },
    touched: (side) => [packOf(side.borrower)],
    created: 0,
  },
  {
    id: 'WP2b',
    title: 'the borrower pack holding the object is immutable',
    darwinOnly: true,
    write: 'blob',
    build: (side) => {
      packed(side.borrower);
      return [packOf(side.borrower)];
    },
    touched: nothing,
    created: 1,
  },
  {
    id: 'WP3',
    title: 'the borrower holds the object only in a cruft pack',
    write: 'blob',
    build: (side) => {
      cruftBorrower(side);
      return [];
    },
    touched: nothing,
    created: 1,
  },
  {
    id: 'WP4',
    title: 'the borrower loose object is immutable and the donor holds it loose too',
    darwinOnly: true,
    write: 'blob',
    build: (side) => {
      borrowerLoose(side);
      donorLoose(side);
      return [loosePath(side.borrower, SUBJECT_ID)];
    },
    touched: (side) => [loosePath(side.donor, SUBJECT_ID)],
    created: 0,
  },
  {
    id: 'WP5',
    title: 'the borrower pack is immutable and the donor holds the object loose',
    darwinOnly: true,
    write: 'blob',
    build: (side) => {
      packed(side.borrower);
      donorLoose(side);
      return [packOf(side.borrower)];
    },
    touched: (side) => [loosePath(side.donor, SUBJECT_ID)],
    created: 0,
  },
  {
    id: 'WP6',
    title: 'the donor pack is immutable and the donor holds the object loose too',
    darwinOnly: true,
    write: 'blob',
    build: (side) => {
      looseAndPacked(side.donor);
      return [packOf(side.donor)];
    },
    touched: (side) => [loosePath(side.donor, SUBJECT_ID)],
    created: 0,
  },
  {
    id: 'WP7',
    title: 'the borrower holds the object both loose and packed',
    write: 'blob',
    build: (side) => {
      looseAndPacked(side.borrower);
      return [];
    },
    touched: (side) => [packOf(side.borrower)],
    created: 0,
  },
  {
    id: 'WP8',
    title: 'the donor pack is read-only (0444) and owned by the caller',
    write: 'blob',
    build: (side) => {
      packed(side.donor);
      chmodSync(packOf(side.donor), 0o444);
      return [];
    },
    touched: (side) => [packOf(side.donor)],
    created: 0,
  },
];

function holds(pack: string, id: string): boolean {
  const idx = pack.replace(/\.pack$/, '.idx');
  return runGit(['show-index'], { input: readFileSync(idx) }).includes(id);
}

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

interface Outcome {
  readonly objects: ReadonlyArray<string>;
  readonly touched: ReadonlyArray<string>;
  readonly created: ReadonlyArray<string>;
  readonly expectedTouched: ReadonlyArray<string>;
  readonly fsckExit: number;
  readonly id: string | undefined;
  readonly refusal: string | undefined;
}

const NEW_SUBJECT = 'a brand new object\n';

const gitWrite = (row: Row, side: Side): { id?: string; refusal?: string } => {
  const dir = side.borrower.dir;
  if (row.write === 'commit-of-donor-tree') {
    const tree = runGit(['-C', side.donor.dir, 'rev-parse', 'HEAD^{tree}']).trim();
    return { id: runGit(['-C', dir, 'commit-tree', tree, '-m', 'm'], { env: commitEnv() }).trim() };
  }
  const input = row.write === 'new-blob' ? NEW_SUBJECT : SUBJECT;
  const result = tryRunGitWithExit(['-C', dir, 'hash-object', '-w', '--stdin'], { input });
  if (result.exitCode !== 0) return { refusal: `${result.exitCode}:${result.stderr}` };
  return { id: result.stdout.trim() };
};

const tsgitWrite = async (row: Row, side: Side): Promise<{ id?: string; refusal?: string }> => {
  const repo = await openRepository({ cwd: side.borrower.dir });
  try {
    if (row.write === 'commit-of-donor-tree') {
      const tree = runGit(['-C', side.donor.dir, 'rev-parse', 'HEAD^{tree}']).trim();
      return { id: await repo.primitives.writeObject(commitObject(tree)) };
    }
    const content = row.write === 'new-blob' ? NEW_SUBJECT : SUBJECT;
    return { id: await repo.primitives.writeObject(blobObject(content)) };
  } catch (error) {
    return { refusal: (error as TsgitError).data.code };
  } finally {
    await repo.dispose();
  }
};

/** git dies 128 naming the signature; tsgit rejects with the structural code. */
const refusalKind = (refusal: string | undefined): Row['refusedBy'] => {
  if (refusal === undefined) return undefined;
  const isSignature =
    refusal.includes(MIDX_SIGNATURE_FATAL) || refusal === 'INVALID_MULTI_PACK_INDEX';
  return isSignature ? 'midx-signature' : undefined;
};

const prepare = (row: Row, peer: string): { side: Side; before: ReadonlyArray<string> } => {
  const side = makeSide(row.id, peer);
  const immutable = row.build(side);
  const before = backdate(side);
  for (const file of immutable) lock(file);
  return { side, before };
};

const observe = (
  row: Row,
  side: Side,
  before: ReadonlyArray<string>,
  written: { id?: string; refusal?: string },
): Outcome => {
  const moved = movedFiles(side);
  const preexisting = new Set(before);
  return {
    objects: primaryObjects(side.borrower),
    touched: moved
      .filter((file) => preexisting.has(file))
      .map(roleOf)
      .sort(),
    created: moved
      .filter((file) => !preexisting.has(file))
      .map(roleOf)
      .sort(),
    expectedTouched: row
      .touched(side)
      .map((file) => roleOf(path.relative(side.root, file)))
      .sort(),
    fsckExit: tryRunGitWithExit(['-C', side.borrower.dir, 'fsck']).exitCode,
    id: written.id,
    refusal: written.refusal,
  };
};

describe.skipIf(!GIT_AVAILABLE)(
  'object freshen interop — a held copy is touched, not rewritten',
  () => {
    for (const row of ROWS) {
      describe.skipIf(row.darwinOnly === true && !DARWIN)(`Given ${row.id}: ${row.title}`, () => {
        describe('When the same object is written by git and by tsgit', () => {
          it(
            'Then both leave the same objects, touch the same files and pass fsck',
            async () => {
              // Arrange
              const peer = prepare(row, 'git');
              const ours = prepare(row, 'ours');

              // Act
              const gitOutcome = observe(row, peer.side, peer.before, gitWrite(row, peer.side));
              const oursOutcome = observe(
                row,
                ours.side,
                ours.before,
                await tsgitWrite(row, ours.side),
              );

              // Assert
              expect(oursOutcome.objects).toEqual(gitOutcome.objects);
              expect(oursOutcome.touched).toEqual(gitOutcome.touched);
              expect(oursOutcome.created).toEqual(gitOutcome.created);
              expect(gitOutcome.touched).toEqual(gitOutcome.expectedTouched);
              expect(gitOutcome.created).toHaveLength(row.created);
              expect(oursOutcome.id).toBe(gitOutcome.id);
              expect(refusalKind(oursOutcome.refusal)).toBe(refusalKind(gitOutcome.refusal));
              expect(refusalKind(gitOutcome.refusal)).toBe(row.refusedBy);
              expect(oursOutcome.fsckExit).toBe(gitOutcome.fsckExit);
            },
            ROW_TIMEOUT,
          );
        });
      });
    }
  },
);

// ---------------------------------------------------------------------------
// FE1 — fetching what an alternate already holds
// ---------------------------------------------------------------------------

const GIT_HTTP_BACKEND = findGitHttpBackend();
const NO_FETCH_BACKEND =
  !GIT_AVAILABLE || GIT_HTTP_BACKEND === undefined || process.cwd().includes('.stryker-tmp');

const initUpstream = (parentDir: string): string => {
  const bare = path.join(parentDir, 'up.git');
  runGit(['init', '--bare', '-q', '-b', 'main', bare]);
  const seed = initWorktree(path.join(parentDir, 'seed'));
  commitIn(seed, SUBJECT);
  runGit(['-C', seed.dir, 'push', '-q', bare, 'main']);
  return bare;
};

const borrowerOver = (dir: string, donorObjects: string, url: string): Repo => {
  const repo = initWorktree(dir);
  mkdirSync(path.join(repo.objects, 'info'), { recursive: true });
  writeFileSync(path.join(repo.objects, 'info', 'alternates'), `${donorObjects}\n`);
  runGit(['-C', dir, 'remote', 'add', 'origin', url]);
  return repo;
};

describe.skipIf(NO_FETCH_BACKEND)(
  'object freshen interop — fetching what an alternate holds',
  () => {
    describe('Given FE1: the borrower alternate is a clone of the upstream', () => {
      describe('When git and tsgit fetch the upstream branch', () => {
        it(
          'Then the ref is created and no object is written to the borrower store',
          async () => {
            // Arrange
            const parentDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-freshen-fe1-'));
            const bare = initUpstream(parentDir);
            const donor = path.join(parentDir, 'donor.git');
            runGit(['clone', '-q', '--bare', bare, donor]);
            const server = await startGitHttpBackend({
              projectRoot: parentDir,
              forwardGitProtocol: true,
            });
            try {
              const url = `http://127.0.0.1:${server.port}/up.git`;
              const peer = borrowerOver(
                path.join(parentDir, 'peer'),
                path.join(donor, 'objects'),
                url,
              );
              const ours = borrowerOver(
                path.join(parentDir, 'ours'),
                path.join(donor, 'objects'),
                url,
              );
              const repo = await openRepository({
                cwd: ours.dir,
                allowInsecureHttp: true,
                config: {
                  allowInsecure: true,
                  allowPrivateNetworks: true,
                  dnsResolver: async () => ['127.0.0.1'],
                },
              });

              // Act
              await gitAsync(peer.dir, '-c', 'protocol.version=2', 'fetch', '-q', 'origin');
              await repo.fetch({ remote: 'origin' });
              await repo.dispose();

              // Assert
              const ref = 'refs/remotes/origin/main';
              expect(runGit(['-C', ours.dir, 'rev-parse', ref]).trim()).toBe(
                runGit(['-C', peer.dir, 'rev-parse', ref]).trim(),
              );
              expect(primaryObjects(ours)).toEqual([]);
              expect(primaryObjects(peer)).toEqual([]);
              expect(tryRunGitWithExit(['-C', ours.dir, 'fsck']).exitCode).toBe(0);
            } finally {
              await server.close();
              await rm(parentDir, { recursive: true, force: true });
            }
          },
          SETUP_TIMEOUT,
        );
      });
    });
  },
);
