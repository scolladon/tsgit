/**
 * Cross-tool interop — what a checkout does with an untracked occupant standing
 * where the target tree adds an entry. The same history is built with git
 * plumbing in a canonical-git peer and in a tsgit repo, the occupant is planted
 * in both work trees, git runs the command in its peer and tsgit in the other,
 * and the work-tree listing, the index and the outcome are compared.
 *
 * @proves
 *   surface:        repo.checkout
 *   bucket:         cross-tool-interop
 *   unique:         checkout occupant classification runs against git
 *   interopSurface: checkout
 */
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TsgitError } from '../../src/domain/error.js';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import {
  GIT_AVAILABLE,
  initBothRepos,
  makePeerPair,
  type PeerPair,
  runGit,
  runGitEnv,
} from './interop-helpers.js';

const SYMLINK_MODE = '120000';
const REGULAR_MODE = '100644';
const GITLINK_MODE = '160000';
const GITLINK_OID = '1111111111111111111111111111111111111111';
const OCCUPANT = 'occupant\n';
const UNTRACKED = 'untracked\n';
const DANGLING_TARGET = 'nowhere';

const COMMIT_ENV: NodeJS.ProcessEnv = {
  ...runGitEnv(),
  GIT_AUTHOR_NAME: 'Ada',
  GIT_AUTHOR_EMAIL: 'ada@example.com',
  GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_NAME: 'Ada',
  GIT_COMMITTER_EMAIL: 'ada@example.com',
  GIT_COMMITTER_DATE: '1700000000 +0000',
};

interface TreeEntry {
  readonly mode: string;
  readonly content: string;
  readonly path: string;
}

type Variant = 'pool' | 'one' | 'in-core';

const VARIANT_CONFIG: Readonly<Record<Variant, ReadonlyArray<readonly [string, string]>>> = {
  pool: [],
  one: [['filter.probe.process', 'true']],
  'in-core': [['core.autocrlf', 'true']],
};

const VARIANTS: ReadonlyArray<Variant> = ['pool', 'one', 'in-core'];

const regular = (entryPath: string, content = 'v2\n'): TreeEntry => ({
  mode: REGULAR_MODE,
  content,
  path: entryPath,
});
const symlink = (entryPath: string, target = 't-v2'): TreeEntry => ({
  mode: SYMLINK_MODE,
  content: target,
  path: entryPath,
});
const gitlink = (entryPath: string): TreeEntry => ({
  mode: GITLINK_MODE,
  content: '',
  path: entryPath,
});

const commitOn = (dir: string, entries: ReadonlyArray<TreeEntry>, parent?: string): string => {
  runGit(['-C', dir, 'read-tree', '--empty']);
  for (const entry of entries) {
    const oid =
      entry.mode === GITLINK_MODE
        ? GITLINK_OID
        : runGit(['-C', dir, 'hash-object', '-w', '--stdin'], { input: entry.content }).trim();
    runGit([
      '-C',
      dir,
      'update-index',
      '--add',
      '--cacheinfo',
      `${entry.mode},${oid},${entry.path}`,
    ]);
  }
  const tree = runGit(['-C', dir, 'write-tree']).trim();
  const parents = parent === undefined ? [] : ['-p', parent];
  return runGit(['-C', dir, 'commit-tree', tree, ...parents, '-m', 'seed'], {
    env: COMMIT_ENV,
  }).trim();
};

const KEEP = regular('keep', 'keep\n');

/** `main` holds only `keep`; `t` is its child and adds the due entries. */
const buildHistory = (dir: string, due: ReadonlyArray<TreeEntry>): void => {
  const main = commitOn(dir, [KEEP]);
  const target = commitOn(dir, [KEEP, ...due], main);
  runGit(['-C', dir, 'update-ref', 'refs/heads/main', main]);
  runGit(['-C', dir, 'update-ref', 'refs/heads/t', target]);
  runGit(['-C', dir, 'reset', '-q', '--hard', 'main']);
};

type Occupant = (dir: string) => void;

const fileAt =
  (rel: string): Occupant =>
  (dir) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), OCCUPANT);
  };
const danglingLinkAt =
  (rel: string): Occupant =>
  (dir) =>
    symlinkSync(DANGLING_TARGET, path.join(dir, rel));
const directoryHolding =
  (rel: string, child: string): Occupant =>
  (dir) => {
    mkdirSync(path.join(dir, rel), { recursive: true });
    writeFileSync(path.join(dir, rel, child), UNTRACKED);
  };
const ignoring =
  (pattern: string, occupant: Occupant): Occupant =>
  (dir) => {
    writeFileSync(path.join(dir, '.git', 'info', 'exclude'), `${pattern}\n`);
    occupant(dir);
  };

interface Outcome {
  readonly refused: boolean;
  readonly crash?: string;
  readonly localChanges: ReadonlyArray<string>;
  readonly untracked: ReadonlyArray<string>;
}

const OK: Outcome = { refused: false, localChanges: [], untracked: [] };
const refusedUntracked = (...paths: ReadonlyArray<string>): Outcome => ({
  refused: true,
  localChanges: [],
  untracked: paths,
});

const LOCAL_CHANGES_HEADER = /local changes/;
const UNTRACKED_HEADER = /untracked/;

/** Reads the refusal class and paths git prints; `lose-untracked` is tsgit's `untracked` (ratified equivalence). */
const outcomeOfGitStderr = (stderr: string): Outcome => {
  const localChanges: string[] = [];
  const untracked: string[] = [];
  let bucket: string[] | undefined;
  for (const line of stderr.split('\n')) {
    if (line.startsWith('\t')) bucket?.push(line.slice(1));
    else if (LOCAL_CHANGES_HEADER.test(line)) bucket = localChanges;
    else if (UNTRACKED_HEADER.test(line)) bucket = untracked;
  }
  return { refused: true, localChanges, untracked };
};

const runGitCheckout = (dir: string, args: ReadonlyArray<string>): Outcome => {
  try {
    runGit(['-C', dir, ...args]);
    return OK;
  } catch (err) {
    const { status, stderr } = err as { status: number | null; stderr: Buffer };
    if (status !== 1) throw err;
    return outcomeOfGitStderr(stderr.toString());
  }
};

const outcomeOfTsgitError = (err: unknown): Outcome => {
  if (!(err instanceof TsgitError)) throw err;
  const data = err.data;
  if (data.code !== 'CHECKOUT_OVERWRITE_DIRTY') {
    return { refused: true, crash: data.code, localChanges: [], untracked: [] };
  }
  return { refused: true, localChanges: data.localChanges, untracked: data.untracked };
};

const runTsgitCheckout = async (repo: Repository): Promise<Outcome> => {
  try {
    await repo.checkout({ rev: 't' });
    return OK;
  } catch (err) {
    return outcomeOfTsgitError(err);
  }
};

const listing = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.parentPath.includes(`${path.sep}.git`) && entry.name !== '.git')
    .map((entry) => {
      const full = path.join(entry.parentPath, entry.name);
      const rel = path.relative(dir, full);
      if (lstatSync(full).isSymbolicLink()) return `${rel}@->${readlinkSync(full)}`;
      return entry.isDirectory() ? `${rel}/` : `${rel}=${readFileSync(full, 'utf8')}`;
    })
    .sort();

const indexState = (dir: string): string[] => [
  runGit(['-C', dir, 'ls-files', '-s']),
  runGit(['-C', dir, 'ls-files', '-t']),
];

interface AddRow {
  readonly shape: string;
  readonly due: ReadonlyArray<TreeEntry>;
  readonly occupant: Occupant;
  readonly git: Outcome;
}

const ADD_ROWS: ReadonlyArray<AddRow> = [
  { shape: 'S1', due: [regular('d/x')], occupant: fileAt('d'), git: refusedUntracked('d') },
  {
    shape: 'S2',
    due: [regular('f')],
    occupant: directoryHolding('f', 'u'),
    git: refusedUntracked('f'),
  },
  {
    shape: 'S3a',
    due: [regular('d/x')],
    occupant: danglingLinkAt('d'),
    git: refusedUntracked('d'),
  },
  { shape: 'S3b', due: [regular('f')], occupant: danglingLinkAt('f'), git: refusedUntracked('f') },
  {
    shape: 'S3c',
    due: [symlink('l')],
    occupant: directoryHolding('l', 'u'),
    git: refusedUntracked('l'),
  },
  { shape: 'S3d', due: [symlink('d/l')], occupant: fileAt('d'), git: refusedUntracked('d') },
  {
    shape: 'S3e',
    due: [symlink('d/l')],
    occupant: danglingLinkAt('d'),
    git: refusedUntracked('d'),
  },
  { shape: 'S3f', due: [symlink('f')], occupant: fileAt('f'), git: refusedUntracked('f') },
  {
    shape: 'I2',
    due: [regular('f')],
    occupant: ignoring('f/u', directoryHolding('f', 'u')),
    git: OK,
  },
  { shape: 'I3', due: [regular('d/x')], occupant: ignoring('d', danglingLinkAt('d')), git: OK },
  {
    shape: 'I5',
    due: [symlink('l')],
    occupant: ignoring('l/u', directoryHolding('l', 'u')),
    git: OK,
  },
  { shape: 'I6', due: [regular('f')], occupant: ignoring('f', fileAt('f')), git: OK },
  { shape: 'I7', due: [regular('f')], occupant: ignoring('f', danglingLinkAt('f')), git: OK },
  { shape: 'X4', due: [gitlink('d/s')], occupant: fileAt('d'), git: refusedUntracked('d') },
  {
    shape: 'Y1',
    due: [regular('d/x'), regular('d/y')],
    occupant: fileAt('d'),
    git: refusedUntracked('d', 'd'),
  },
];

describe.skipIf(!GIT_AVAILABLE)(
  'checkout interop — occupant where the target adds an entry',
  { timeout: 60_000 },
  () => {
    let pair: PeerPair;
    let repo: Repository | undefined;

    beforeEach(async () => {
      pair = await makePeerPair('checkout-occupant-displacement');
      initBothRepos(pair.peer, pair.ours);
      repo = undefined;
    });

    afterEach(async () => {
      await repo?.dispose();
      await pair.dispose();
    });

    describe.each(VARIANTS)('Given the %s write path', (variant) => {
      describe.each(ADD_ROWS)('and the $shape occupant, HEAD lacking the entry', (row) => {
        describe('When both tools run checkout t', () => {
          it('Then the outcome, work tree and index match git', async () => {
            // Arrange
            for (const dir of [pair.peer, pair.ours]) {
              for (const [key, value] of VARIANT_CONFIG[variant]) {
                runGit(['-C', dir, 'config', key, value]);
              }
              buildHistory(dir, row.due);
              row.occupant(dir);
            }
            repo = await openRepository({ cwd: pair.ours });

            // Act
            const expected = runGitCheckout(pair.peer, ['checkout', '-q', 't']);
            const result = await runTsgitCheckout(repo);

            // Assert
            expect(expected).toEqual(row.git);
            expect(result).toEqual(expected);
            expect(listing(pair.ours)).toEqual(listing(pair.peer));
            expect(indexState(pair.ours)).toEqual(indexState(pair.peer));
          });
        });
      });
    });
  },
);
