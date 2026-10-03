/**
 * Cross-tool interop — the commit-graph a read walk loads. Each row damages a
 * real `git commit-graph write` result, runs real `git log`, and opens the same
 * repository through tsgit: the layers tsgit serves and the warnings it logs
 * must be the ones git's loader settles on and prints.
 *
 * @proves
 *   surface:        log, walkCommits
 *   bucket:         cross-tool-interop
 *   unique:         the commit-graph read path loads, refuses and warns about layers as git's loader does
 *   interopSurface: commit-graph
 */
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commitHeader } from '../../src/application/primitives/internal/read-commit-graph.js';
import type { ObjectId } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  runGit,
  tryRunGitWithExit,
} from './interop-helpers.js';

const ROW_TIMEOUT = 30_000;
const GIT_SUCCEEDED = 0;
const WARNING_PREFIX = /^(warning|error): /;
const LOGGER_PREFIX = 'commitGraph: ';

let root: string;
let rowCount = 0;

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tsgit-interop-cgraph-read-')));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Linear {
  readonly dir: string;
  /** Oldest first. */
  readonly commits: ReadonlyArray<ObjectId>;
  readonly layersDir: string;
}

const linearHistory = (count: number): Linear => {
  rowCount += 1;
  const dir = path.join(root, `repo-${rowCount}`);
  runGit(['init', '-q', '-b', 'main', dir]);
  disableAutoMaintenance(dir);
  for (let n = 1; n <= count; n += 1) {
    const date = `@${1_700_000_000 + n} +0000`;
    runGit(['-C', dir, 'commit', '-q', '--allow-empty', '-m', `c${n}`], {
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
  }
  const commits = runGit(['-C', dir, 'rev-list', '--reverse', 'HEAD']).trim().split('\n');
  const layersDir = path.join(dir, '.git', 'objects', 'info', 'commit-graphs');
  return { dir, commits: commits as ObjectId[], layersDir };
};

const writeSplitAt = (repo: Linear, tip: ObjectId): void => {
  runGit(['-C', repo.dir, 'commit-graph', 'write', '--split=no-merge', '--stdin-commits'], {
    input: `${tip}\n`,
  });
};

const chainPath = (repo: Linear): string => path.join(repo.layersDir, 'commit-graph-chain');

const chainLines = (repo: Linear): ReadonlyArray<string> =>
  readFileSync(chainPath(repo), 'utf8').trim().split('\n');

const layerPath = (repo: Linear, hash: string): string =>
  path.join(repo.layersDir, `graph-${hash}.graph`);

const gitWarnings = (repo: Linear): { readonly exitCode: number; readonly lines: string[] } => {
  const result = tryRunGitWithExit(['-C', repo.dir, 'log', '--format=%H']);
  const lines = result.stderr
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => line.replace(WARNING_PREFIX, ''));
  return { exitCode: result.exitCode, lines };
};

const tsgitServes = async (repo: Linear, ids: ReadonlyArray<ObjectId>) => {
  const warnings: string[] = [];
  const logger = { warn: (message: string) => warnings.push(message) };
  const opened = await openRepository({ cwd: repo.dir, logger });
  try {
    const served: boolean[] = [];
    for (const id of ids) served.push((await commitHeader(opened.ctx, id)) !== undefined);
    return { served, warnings: warnings.map((line) => line.replace(LOGGER_PREFIX, '')) };
  } finally {
    await opened.dispose?.();
  }
};

describe.skipIf(!GIT_AVAILABLE)('commit-graph read interop', () => {
  describe('Given a chain whose second line names a layer built on a different base', () => {
    describe('When both tools load the graph', () => {
      it(
        'Then both warn the chain does not match and serve only the first layer',
        async () => {
          // Arrange
          const repo = linearHistory(4);
          const [c1, c2, , c4] = repo.commits as [ObjectId, ObjectId, ObjectId, ObjectId];
          writeSplitAt(repo, c1);
          const [foreign] = chainLines(repo) as [string];
          const foreignBytes = readFileSync(layerPath(repo, foreign));
          rmSync(repo.layersDir, { recursive: true });
          writeSplitAt(repo, c2);
          writeSplitAt(repo, c4);
          const [, tip] = chainLines(repo) as [string, string];
          chmodSync(chainPath(repo), 0o644);
          writeFileSync(layerPath(repo, foreign), foreignBytes);
          writeFileSync(chainPath(repo), `${foreign}\n${tip}\n`);

          // Act
          const git = gitWarnings(repo);
          const ours = await tsgitServes(repo, [c1, c2, c4]);

          // Assert
          expect(git.exitCode).toBe(GIT_SUCCEEDED);
          expect(git.lines).toEqual([
            'commit-graph chain does not match',
            'unable to find all commit-graph files',
          ]);
          expect(ours.warnings).toEqual(git.lines);
          expect(ours.served).toEqual([true, false, false]);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe.each([
    { label: 'more base graphs than its BASE chunk holds', declared: 2 },
    { label: 'no base graph at all', declared: 0 },
  ])('Given a tip layer whose header declares $label', ({ declared }) => {
    describe('When both tools load the graph', () => {
      it(
        'Then both read BASE by its chunk and serve every layer without a warning',
        async () => {
          // Arrange
          const repo = linearHistory(3);
          const [c1, , c3] = repo.commits as [ObjectId, ObjectId, ObjectId];
          writeSplitAt(repo, c1);
          writeSplitAt(repo, c3);
          const [, tip] = chainLines(repo) as [string, string];
          const tipFile = layerPath(repo, tip);
          chmodSync(tipFile, 0o644);
          const bytes = new Uint8Array(readFileSync(tipFile));
          bytes[7] = declared;
          writeFileSync(tipFile, bytes);

          // Act
          const git = gitWarnings(repo);
          const ours = await tsgitServes(repo, [c1, c3]);

          // Assert
          expect(git.exitCode).toBe(GIT_SUCCEEDED);
          expect(git.lines).toEqual([]);
          expect(ours.warnings).toEqual(git.lines);
          expect(ours.served).toEqual([true, true]);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given a single-file graph whose GDA2 chunk is one entry short', () => {
    describe('When both tools load the graph', () => {
      it(
        'Then both report the generations chunk wrong-sized and still serve the graph',
        async () => {
          // Arrange
          const repo = linearHistory(2);
          runGit(['-C', repo.dir, 'commit-graph', 'write', '--reachable']);
          const file = path.join(repo.dir, '.git', 'objects', 'info', 'commit-graph');
          chmodSync(file, 0o644);
          const bytes = new Uint8Array(readFileSync(file));
          const view = new DataView(bytes.buffer);
          const rows = Buffer.from(bytes.subarray(0, 8 + 12 * ((bytes[6] as number) + 1)));
          const endOffsetLow = rows.indexOf('GDA2', 8, 'latin1') + 12 + 8;
          view.setUint32(endOffsetLow, view.getUint32(endOffsetLow) - 4);
          writeFileSync(file, bytes);

          // Act
          const git = gitWarnings(repo);
          const ours = await tsgitServes(repo, [...repo.commits]);

          // Assert
          expect(git.exitCode).toBe(GIT_SUCCEEDED);
          expect(git.lines).toEqual(['commit-graph generations chunk is wrong size']);
          expect(ours.warnings).toEqual(git.lines);
          expect(ours.served).toEqual([true, true]);
        },
        ROW_TIMEOUT,
      );
    });
  });

  describe('Given a single-file graph whose signature is smashed', () => {
    describe('When both tools load the graph', () => {
      it(
        'Then both refuse the file and report the signature it carries',
        async () => {
          // Arrange
          const repo = linearHistory(2);
          runGit(['-C', repo.dir, 'commit-graph', 'write', '--reachable']);
          const file = path.join(repo.dir, '.git', 'objects', 'info', 'commit-graph');
          chmodSync(file, 0o644);
          const bytes = new Uint8Array(readFileSync(file));
          bytes[0] = 0x58;
          writeFileSync(file, bytes);
          const failures: unknown[] = [];
          const opened = await openRepository({
            cwd: repo.dir,
            logger: { warn: (_message, context) => failures.push(context?.failure) },
          });

          // Act
          const git = gitWarnings(repo);
          const served = await commitHeader(opened.ctx, repo.commits[0] as ObjectId);
          await opened.dispose?.();

          // Assert
          const [failure] = failures as [{ kind: string; found: number }];
          expect(git.exitCode).toBe(GIT_SUCCEEDED);
          expect(served).toBeUndefined();
          expect(git.lines).toEqual([
            `commit-graph signature ${failure.found.toString(16).toUpperCase()} does not match signature 43475048`,
          ]);
          expect(failure.kind).toBe('signature');
        },
        ROW_TIMEOUT,
      );
    });
  });
});
