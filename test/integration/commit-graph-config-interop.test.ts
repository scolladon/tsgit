/**
 * Cross-tool interop — `core.commitGraph`. A commit-graph whose parent data
 * disagrees with the objects (the tip's first parent rewired to the root)
 * makes a graph-served walk observably different from an object walk. git
 * serves the walk from the graph unless `core.commitGraph` is false; each row
 * runs real `git rev-list` and tsgit's on the same repository.
 *
 * @proves
 *   surface:        commit-graph
 *   bucket:         cross-tool-interop
 *   unique:         core.commitGraph=false leaves the commit-graph unread, so the walk follows the objects
 *   interopSurface: revList
 */
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TsgitError } from '../../src/domain/error.js';
import { openRepository } from '../../src/index.node.js';
import { GIT_AVAILABLE, runGit, tryRunGitWithExit } from './interop-helpers.js';

const ROW_TIMEOUT = 30_000;
const HEADER_BYTES = 8;
const CHUNK_ROW_BYTES = 12;
const FANOUT_LAST_ENTRY = 255 * 4;
const SHA1_BYTES = 20;
const CDAT_ROW_BYTES = SHA1_BYTES + 16;

let root: string;
let count = 0;

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tsgit-interop-commit-graph-config-')));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The graph's chunk offsets by four-character id. */
const chunkOffsets = (view: DataView, bytes: Uint8Array): ReadonlyMap<string, number> => {
  const offsets = new Map<string, number>();
  for (let i = 0; i < bytes[6]!; i += 1) {
    const at = HEADER_BYTES + CHUNK_ROW_BYTES * i;
    const id = new TextDecoder().decode(bytes.subarray(at, at + 4));
    offsets.set(id, Number(view.getBigUint64(at + 4)));
  }
  return offsets;
};

/** Rewire `from`'s first parent, in the graph only, to `to`. */
const rewireFirstParent = (file: string, from: string, to: string): void => {
  const bytes = new Uint8Array(readFileSync(file));
  const view = new DataView(bytes.buffer);
  const chunks = chunkOffsets(view, bytes);
  const total = view.getUint32(chunks.get('OIDF')! + FANOUT_LAST_ENTRY);
  const oidl = chunks.get('OIDL')!;
  const oids = Array.from({ length: total }, (_, i) =>
    Buffer.from(bytes.subarray(oidl + SHA1_BYTES * i, oidl + SHA1_BYTES * (i + 1))).toString('hex'),
  );
  view.setUint32(
    chunks.get('CDAT')! + CDAT_ROW_BYTES * oids.indexOf(from) + SHA1_BYTES,
    oids.indexOf(to),
  );
  chmodSync(file, 0o644);
  writeFileSync(file, bytes);
};

/** Three empty commits whose graph skips the middle one, under `[core] commitGraph`. */
const rewiredRepo = (commitGraph: string | undefined): string => {
  count += 1;
  const dir = path.join(root, `repo-${count}`);
  runGit(['init', '-q', '-b', 'main', dir]);
  for (const message of ['c1', 'c2', 'c3']) {
    runGit(['-C', dir, 'commit', '-q', '--allow-empty', '-m', message]);
  }
  runGit(['-C', dir, 'commit-graph', 'write', '--reachable']);
  const tip = runGit(['-C', dir, 'rev-parse', 'HEAD']).trim();
  const rootCommit = runGit(['-C', dir, 'rev-parse', 'HEAD~2']).trim();
  rewireFirstParent(path.join(dir, '.git', 'objects', 'info', 'commit-graph'), tip, rootCommit);
  if (commitGraph !== undefined) runGit(['-C', dir, 'config', 'core.commitGraph', commitGraph]);
  return dir;
};

const tsgitWalk = async (dir: string): Promise<ReadonlyArray<string>> => {
  const repo = await openRepository({ cwd: dir });
  try {
    return (await repo.revList({ wants: ['HEAD'] })).entries.map((entry) => entry.id);
  } finally {
    await repo.dispose();
  }
};

describe.skipIf(!GIT_AVAILABLE)('interop — core.commitGraph', () => {
  describe.each([
    { name: 'false', value: 'false' },
    { name: '0', value: '0' },
    { name: 'true', value: 'true' },
    { name: 'unset', value: undefined },
  ])('Given a rewired commit-graph and core.commitGraph $name', ({ value }) => {
    describe('When git and tsgit list the commits reachable from HEAD', () => {
      it(
        'Then both walk the same commits',
        async () => {
          // Arrange
          const dir = rewiredRepo(value);
          const gitWalk = runGit(['-C', dir, 'rev-list', 'HEAD']).trim().split('\n');
          const sut = tsgitWalk;

          // Act
          const result = await sut(dir);

          // Assert
          expect(result).toEqual(gitWalk);
        },
        ROW_TIMEOUT,
      );
    });
  });
});

interface ConfigRefusal {
  readonly code: string;
  readonly key: string;
  readonly value: string;
  readonly reason?: string;
}

/** git's fatal line for a refused config value, rebuilt from tsgit's refusal data. */
const fatalLineOf = (refusal: ConfigRefusal | undefined): string => {
  if (refusal === undefined) return '';
  if (refusal.code === 'CONFIG_BAD_BOOLEAN_VALUE') {
    return `fatal: bad boolean config value '${refusal.value}' for '${refusal.key}'\n`;
  }
  return `fatal: bad numeric config value '${refusal.value}' for '${refusal.key}' in file .git/config: ${refusal.reason}\n`;
};

const tsgitLogRefusal = async (dir: string): Promise<ConfigRefusal | undefined> => {
  const repo = await openRepository({ cwd: dir });
  try {
    await repo.log();
    return undefined;
  } catch (error) {
    return (error as TsgitError).data as ConfigRefusal;
  } finally {
    await repo.dispose();
  }
};

const GENERATION_VERSION_ROWS: ReadonlyArray<{
  readonly label: string;
  readonly config: ReadonlyArray<readonly [string, string]>;
}> = [
  { label: 'abc', config: [['commitGraph.generationVersion', 'abc']] },
  { label: 'past the C int ceiling', config: [['commitGraph.generationVersion', '2147483648']] },
  { label: '1k', config: [['commitGraph.generationVersion', '1k']] },
  {
    label: 'abc and a later-read malformed commitGraph.readChangedPaths',
    config: [
      ['commitGraph.readChangedPaths', 'maybe'],
      ['commitGraph.generationVersion', 'abc'],
    ],
  },
  {
    label: 'abc and an earlier-read malformed core.commitGraph',
    config: [
      ['commitGraph.generationVersion', 'abc'],
      ['core.commitGraph', 'maybe'],
    ],
  },
  {
    label: 'abc and a later-read malformed core.maxTreeDepth',
    config: [
      ['core.maxTreeDepth', 'zz'],
      ['commitGraph.generationVersion', 'abc'],
    ],
  },
];

describe.skipIf(!GIT_AVAILABLE)('interop — commitGraph.generationVersion', () => {
  describe.each(GENERATION_VERSION_ROWS)(
    'Given commitGraph.generationVersion $label',
    ({ config }) => {
      describe('When git and tsgit log HEAD', () => {
        it(
          'Then both refuse the same value, or both read the history',
          async () => {
            // Arrange
            count += 1;
            const dir = path.join(root, `generation-version-${count}`);
            runGit(['init', '-q', '-b', 'main', dir]);
            runGit(['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'c1']);
            for (const [key, value] of config) {
              runGit(['-C', dir, 'config', key, value]);
            }
            const git = tryRunGitWithExit(['-C', dir, 'log', '--format=%H']);
            const sut = tsgitLogRefusal;

            // Act
            const result = await sut(dir);

            // Assert
            expect(fatalLineOf(result)).toBe(git.exitCode === 0 ? '' : git.stderr);
          },
          ROW_TIMEOUT,
        );
      });
    },
  );
});
