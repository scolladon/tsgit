/**
 * Cross-tool interop — changed-path Bloom filters in the commit-graph. Real
 * git turns them on (`git commit-graph write --reachable --changed-paths`)
 * over a history that exercises every filter shape: nested directories, a
 * file turned directory, a removed directory, a mode-only change, an empty
 * commit, a merge (first-parent diff), a high-bit path (where hash versions
 * 1 and 2 disagree), a commit at exactly 512 paths and one past it. Then
 * one more commit lands and both tools rewrite — tsgit on one twin, git on
 * the other — and the graph files must match byte-for-byte: the existing
 * graph's BDAT settings carry over, git's way.
 *
 * @proves
 *   surface:        commitGraph
 *   bucket:         cross-tool-interop
 *   unique:         tsgit's commit-graph writes carry and compute changed-path Bloom filters byte-identically to git
 *   interopSurface: commitGraph
 */
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { maintenance } from '../../src/application/commands/maintenance.js';
import { writeCommitGraph } from '../../src/application/primitives/write-commit-graph.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  git,
  runGit,
  runGitEnv,
} from './interop-helpers.js';

const SETUP_TIMEOUT = 120_000;
const HIGH_BIT_PATH = 'été/café';

const tmpDir = (slug: string): Promise<string> =>
  mkdtemp(path.join(os.tmpdir(), `tsgit-changed-paths-${slug}-`));

let tick = 1_700_000_000;
const commitAll = (dir: string, message: string, ...extra: string[]): void => {
  tick += 60;
  const date = `@${tick} +0000`;
  runGit(['-C', dir, 'commit', '-q', ...extra, '-m', message], {
    env: { ...runGitEnv(), GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
};

async function writeFiles(dir: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), content);
  }
  git(dir, 'add', '-A');
}

const numbered = (dir: string, count: number): Record<string, string> =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [`${dir}/${i}`, `${i}\n`]));

/** A high-bit path staged through the index alone — the filesystem never normalises it. */
function stageHighBitPath(dir: string): void {
  const blob = runGit(['-C', dir, 'hash-object', '-w', '--stdin'], { input: 'h\n' }).trim();
  git(dir, 'update-index', '--add', '--cacheinfo', `100644,${blob},${HIGH_BIT_PATH}`);
}

async function buildHistory(): Promise<string> {
  const dir = await tmpDir('base');
  git(dir, 'init', '-q', '-b', 'main');
  for (const [key, value] of [
    ['user.name', 'A U Thor'],
    ['user.email', 'author@example.com'],
    ['commit.gpgsign', 'false'],
  ]) {
    git(dir, 'config', key!, value!);
  }
  disableAutoMaintenance(dir);
  await writeFiles(dir, { p: 'p\n', 'd/e/f': 'f\n', 'd/g': 'g\n', run: 'r\n' });
  commitAll(dir, 'root');
  await writeFiles(dir, { 'd/e/f': 'f2\n' });
  commitAll(dir, 'nested edit');
  git(dir, 'update-index', '--chmod=+x', 'run');
  commitAll(dir, 'mode only');
  await rm(path.join(dir, 'p'));
  await writeFiles(dir, { 'p/inner': 'i\n' });
  commitAll(dir, 'file to directory');
  await rm(path.join(dir, 'd', 'e'), { recursive: true });
  git(dir, 'add', '-A');
  commitAll(dir, 'remove directory');
  commitAll(dir, 'empty', '--allow-empty');
  git(dir, 'checkout', '-q', '-b', 'side');
  await writeFiles(dir, { 'side/s': 's\n' });
  commitAll(dir, 'side');
  git(dir, 'checkout', '-q', 'main');
  await writeFiles(dir, { 'm/x': 'x\n' });
  commitAll(dir, 'main');
  runGit(['-C', dir, 'merge', '-q', '--no-edit', 'side'], {
    env: {
      ...runGitEnv(),
      GIT_AUTHOR_DATE: `@${tick} +0000`,
      GIT_COMMITTER_DATE: `@${tick} +0000`,
    },
  });
  stageHighBitPath(dir);
  commitAll(dir, 'high bit');
  await writeFiles(dir, numbered('mid', 511));
  commitAll(dir, 'exactly the maximum');
  await writeFiles(dir, numbered('big', 512));
  commitAll(dir, 'one past the maximum');
  return dir;
}

interface Twin {
  readonly peerDir: string;
  readonly oursDir: string;
}

/** Twins of `baseDir` after `prepare` runs in it, each with one more commit on top. */
async function twinWithNewCommit(
  baseDir: string,
  slug: string,
  prepare: (dir: string) => void,
): Promise<Twin> {
  const staging = await tmpDir(`${slug}-staging`);
  await cp(baseDir, staging, { recursive: true });
  prepare(staging);
  await writeFiles(staging, { [`tip-${slug}`]: 't\n' });
  commitAll(staging, 'tip');
  const peerDir = await tmpDir(`${slug}-peer`);
  const oursDir = await tmpDir(`${slug}-ours`);
  await cp(staging, peerDir, { recursive: true });
  await cp(staging, oursDir, { recursive: true });
  await rm(staging, { recursive: true, force: true });
  return { peerDir, oursDir };
}

/** Every file under `objects/info`, keyed by its relative path, as hex. */
async function graphFiles(dir: string): Promise<Record<string, string>> {
  const info = path.join(dir, '.git', 'objects', 'info');
  const entries = await readdir(info, { recursive: true, withFileTypes: true });
  const files: Record<string, string> = {};
  for (const entry of entries.filter((e) => e.isFile() && !e.name.startsWith('packs'))) {
    const full = path.join(entry.parentPath, entry.name);
    files[path.relative(info, full)] = (await readFile(full)).toString('hex');
  }
  return files;
}

const BIDX_HEX = Buffer.from('BIDX').toString('hex');

async function disposeTwin(twin: Twin): Promise<void> {
  await rm(twin.peerDir, { recursive: true, force: true });
  await rm(twin.oursDir, { recursive: true, force: true });
}

const ours = (twin: Twin) => createNodeContext({ workDir: twin.oursDir, algorithm: 'sha1' });

describe.skipIf(!GIT_AVAILABLE)('commit-graph changed-path filters interop', () => {
  let baseDir: string;

  beforeAll(async () => {
    baseDir = await buildHistory();
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  describe.each([
    { label: 'version 1', version: '1' },
    { label: 'version 2', version: '2' },
  ])('Given a single-file graph git wrote with $label changed paths', ({ version }) => {
    const writeChangedPaths = (dir: string): void => {
      runGit([
        '-C',
        dir,
        '-c',
        `commitGraph.changedPathsVersion=${version}`,
        'commit-graph',
        'write',
        '--reachable',
        '--changed-paths',
      ]);
    };

    describe('When both tools rewrite the single-file graph', () => {
      it('Then the graph and its BIDX/BDAT chunks are byte-identical', async () => {
        // Arrange
        const twin = await twinWithNewCommit(baseDir, `single-v${version}`, writeChangedPaths);
        git(twin.peerDir, 'commit-graph', 'write', '--reachable');
        const sut = writeCommitGraph;

        // Act
        await sut(ours(twin));

        // Assert
        const peer = await graphFiles(twin.peerDir);
        expect(peer['commit-graph']).toContain(BIDX_HEX);
        expect(await graphFiles(twin.oursDir)).toEqual(peer);
        await disposeTwin(twin);
      });
    });

    describe('When both tools run the commit-graph maintenance task', () => {
      it('Then the chain and every layer are byte-identical', async () => {
        // Arrange
        const twin = await twinWithNewCommit(baseDir, `split-v${version}`, writeChangedPaths);
        git(twin.peerDir, 'maintenance', 'run', '--task=commit-graph');
        const sut = maintenance;

        // Act
        await sut(ours(twin), { tasks: ['commit-graph'] });

        // Assert
        const peer = await graphFiles(twin.peerDir);
        expect(Object.values(peer).filter((hex) => hex.includes(BIDX_HEX))).toHaveLength(2);
        expect(await graphFiles(twin.oursDir)).toEqual(peer);
        await disposeTwin(twin);
      });
    });
  });

  describe('Given a version 1 graph and commitGraph.changedPathsVersion 2 configured', () => {
    describe('When both tools rewrite the single-file graph', () => {
      it('Then the filters are rewritten at version 2, the high-bit path rehashed', async () => {
        // Arrange
        const twin = await twinWithNewCommit(baseDir, 'upgrade', (dir) => {
          git(dir, 'commit-graph', 'write', '--reachable', '--changed-paths');
          git(dir, 'config', 'commitGraph.changedPathsVersion', '2');
        });
        git(twin.peerDir, 'commit-graph', 'write', '--reachable');
        const sut = writeCommitGraph;

        // Act
        await sut(ours(twin));

        // Assert
        expect(await graphFiles(twin.oursDir)).toEqual(await graphFiles(twin.peerDir));
        await disposeTwin(twin);
      });
    });
  });

  describe('Given a graph without changed paths and commitGraph.changedPaths set', () => {
    describe('When both tools run the commit-graph maintenance task', () => {
      it('Then the new layer carries filters, its base none', async () => {
        // Arrange
        const twin = await twinWithNewCommit(baseDir, 'enable', (dir) => {
          git(dir, 'commit-graph', 'write', '--reachable');
          git(dir, 'config', 'commitGraph.changedPaths', 'true');
        });
        git(twin.peerDir, 'maintenance', 'run', '--task=commit-graph');
        const sut = maintenance;

        // Act
        await sut(ours(twin), { tasks: ['commit-graph'] });

        // Assert
        const peer = await graphFiles(twin.peerDir);
        expect(Object.values(peer).filter((hex) => hex.includes(BIDX_HEX))).toHaveLength(1);
        expect(await graphFiles(twin.oursDir)).toEqual(peer);
        await disposeTwin(twin);
      });
    });
  });

  describe('Given a graph with changed paths and commitGraph.readChangedPaths false', () => {
    describe('When both tools rewrite the single-file graph', () => {
      it('Then neither carries the filters over', async () => {
        // Arrange
        const twin = await twinWithNewCommit(baseDir, 'unread', (dir) => {
          git(dir, 'commit-graph', 'write', '--reachable', '--changed-paths');
          git(dir, 'config', 'commitGraph.readChangedPaths', 'false');
        });
        git(twin.peerDir, 'commit-graph', 'write', '--reachable');
        const sut = writeCommitGraph;

        // Act
        await sut(ours(twin));

        // Assert
        const peer = await graphFiles(twin.peerDir);
        expect(peer['commit-graph']).not.toContain(BIDX_HEX);
        expect(await graphFiles(twin.oursDir)).toEqual(peer);
        await disposeTwin(twin);
      });
    });
  });
});
