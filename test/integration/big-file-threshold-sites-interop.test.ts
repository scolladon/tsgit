/**
 * Cross-tool interop — a malformed `core.bigFileThreshold` at git's data
 * sites. git reads the key lazily (last entry wins) only where it is about to
 * hash a regular working-tree file or weigh an object's content, so the same
 * command refuses or runs depending on the repository's state: a racy index
 * entry is hashed, a stat-clean one is not; a packed blob is streamed, a
 * loose one is not. Each row runs real git and tsgit on twin repositories and
 * rebuilds git's fatal line from tsgit's structured error data.
 *
 * @proves
 *   surface:        repo-state
 *   bucket:         cross-tool-interop
 *   unique:         a malformed core.bigFileThreshold refuses exactly where git reads it, per repository state
 *   interopSurface: add, diff, show, status
 */
import { mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openRepository, type Repository } from '../../src/index.node.js';
import { GIT_AVAILABLE, runGit, tryRunGitWithExit } from './interop-helpers.js';

const ROW_TIMEOUT = 30_000;
const LONG_AGO = new Date('2000-01-01T00:00:00Z');
const MALFORMED = '[core]\n\tbigFileThreshold = x\n';

interface RepoState {
  /** The index file predates its entries, so git hashes every stat-matching file. */
  readonly racy: boolean;
  /** Every object lives in one pack instead of loose. */
  readonly packed: boolean;
}

let root: string;
let count = 0;

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tsgit-interop-big-file-sites-')));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const commitFile = (dir: string, name: string): void => {
  writeFileSync(path.join(dir, name), `content ${name}\n`);
  runGit(['-C', dir, 'add', name]);
  runGit(['-C', dir, 'commit', '-qm', name]);
};

/** Two commits (`f1.txt`, then `f2.txt`), in `state`, under a malformed threshold. */
const repoIn = (state: RepoState): string => {
  count += 1;
  const dir = path.join(root, `repo-${count}`);
  runGit(['init', '-q', '-b', 'main', dir]);
  commitFile(dir, 'f1.txt');
  commitFile(dir, 'f2.txt');
  if (state.packed) runGit(['-C', dir, 'repack', '-adq']);
  if (state.packed) runGit(['-C', dir, 'prune-packed']);
  if (!state.racy) {
    for (const name of ['f1.txt', 'f2.txt']) utimesSync(path.join(dir, name), LONG_AGO, LONG_AGO);
    runGit(['-C', dir, 'update-index', '-q', '--really-refresh']);
  }
  if (state.racy) utimesSync(path.join(dir, '.git', 'index'), LONG_AGO, LONG_AGO);
  writeFileSync(path.join(dir, '.git', 'config'), MALFORMED, { flag: 'a' });
  return dir;
};

/** git's fatal line, rebuilt from tsgit's refusal; `undefined` when the command ran. */
const tsgitFatal = async (
  dir: string,
  op: (repo: Repository) => Promise<unknown>,
): Promise<string | undefined> => {
  const repo = await openRepository({ cwd: dir });
  try {
    await op(repo);
    return undefined;
  } catch (err) {
    const data = (err as { readonly data?: Record<string, string> }).data;
    if (data?.code !== 'CONFIG_BAD_NUMERIC_VALUE') throw err;
    const source = path.relative(dir, data.source as string);
    return `fatal: bad numeric config value '${data.value}' for '${data.key}' in file ${source}: ${data.reason}\n`;
  } finally {
    await repo.dispose();
  }
};

interface Row {
  readonly name: string;
  readonly state: RepoState;
  readonly git: ReadonlyArray<string>;
  readonly tsgit: (repo: Repository) => Promise<unknown>;
}

const RACY_LOOSE: RepoState = { racy: true, packed: false };
const CLEAN_LOOSE: RepoState = { racy: false, packed: false };
const RACY_PACKED: RepoState = { racy: true, packed: true };
const CLEAN_PACKED: RepoState = { racy: false, packed: true };

const ROWS: ReadonlyArray<Row> = [
  {
    name: 'status, racy',
    state: RACY_LOOSE,
    git: ['status', '--porcelain'],
    tsgit: (r) => r.status(),
  },
  {
    name: 'status, stat-clean',
    state: CLEAN_LOOSE,
    git: ['status', '--porcelain'],
    tsgit: (r) => r.status(),
  },
  {
    name: 'status, racy packed',
    state: RACY_PACKED,
    git: ['status', '--porcelain'],
    tsgit: (r) => r.status(),
  },
  {
    name: 'status, stat-clean packed',
    state: CLEAN_PACKED,
    git: ['status', '--porcelain'],
    tsgit: (r) => r.status(),
  },
  { name: 'add, racy', state: RACY_LOOSE, git: ['add', 'f1.txt'], tsgit: (r) => r.add(['f1.txt']) },
  {
    name: 'add, stat-clean',
    state: CLEAN_LOOSE,
    git: ['add', 'f1.txt'],
    tsgit: (r) => r.add(['f1.txt']),
  },
  {
    name: 'diff --stat between commits',
    state: CLEAN_LOOSE,
    git: ['diff', '--stat', 'HEAD~1', 'HEAD'],
    tsgit: (r) => r.diff({ from: 'HEAD~1', to: 'HEAD', withStat: true }),
  },
  {
    name: 'diff --raw between commits',
    state: CLEAN_LOOSE,
    git: ['diff', '--raw', 'HEAD~1', 'HEAD'],
    tsgit: (r) => r.diff({ from: 'HEAD~1', to: 'HEAD' }),
  },
  {
    name: 'diff -w --raw between commits',
    state: CLEAN_LOOSE,
    git: ['diff', '-w', '--raw', 'HEAD~1', 'HEAD'],
    tsgit: (r) => r.diff({ from: 'HEAD~1', to: 'HEAD', ignoreWhitespace: 'all' }),
  },
  {
    name: 'show --stat',
    state: CLEAN_LOOSE,
    git: ['show', '--stat', 'HEAD'],
    tsgit: (r) => r.show('HEAD', { withStat: true }),
  },
  {
    name: 'show --raw',
    state: CLEAN_LOOSE,
    git: ['show', '--raw', 'HEAD'],
    tsgit: (r) => r.show('HEAD'),
  },
];

describe.skipIf(!GIT_AVAILABLE)(
  'interop — malformed core.bigFileThreshold at git data sites',
  () => {
    describe.each(ROWS)('Given $name', ({ state, git, tsgit }) => {
      describe('When git and tsgit run the command', () => {
        it(
          'Then both refuse with the same fatal line, or both run',
          async () => {
            // Arrange
            const gitRun = tryRunGitWithExit(['-C', repoIn(state), ...git]);
            const dir = repoIn(state);
            const sut = tsgitFatal;

            // Act
            const result = await sut(dir, tsgit);

            // Assert
            expect(result).toBe(gitRun.exitCode === 128 ? gitRun.stderr : undefined);
          },
          ROW_TIMEOUT,
        );
      });
    });
  },
);
