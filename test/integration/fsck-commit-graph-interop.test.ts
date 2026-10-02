/**
 * Cross-tool interop — fsck's `commit-graph verify` leg. Each row damages a
 * real `git commit-graph write --reachable` file the same way for both tools
 * (restamping its trailer unless the trailer is the damage), runs real
 * `git fsck` and tsgit's, and rebuilds git's stderr lines from tsgit's
 * structured findings.
 *
 * @proves
 *   surface:        fsck
 *   bucket:         cross-tool-interop
 *   unique:         tsgit fsck reports every commit-graph verify line git prints, with bit 16
 *   interopSurface: fsck
 */
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FsckFinding } from '../../src/application/commands/fsck.js';
import { parseCommitGraphLayer, positionOf } from '../../src/domain/commit/commit-graph.js';
import type { ObjectId } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import {
  disableAutoMaintenance,
  GIT_AVAILABLE,
  runGit,
  tryRunGitWithExit,
} from './interop-helpers.js';

const ROW_TIMEOUT = 30_000;
const HASH_LENGTH = 20;
const NO_PARENT = 0x70000000;
const EXIT_COMMIT_GRAPH = 16;
const DATE_ENV = { GIT_AUTHOR_DATE: '@1700000000 +0000', GIT_COMMITTER_DATE: '@1700000000 +0000' };

let root: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'tsgit-interop-fsck-commit-graph-')));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

interface History {
  readonly dir: string;
  readonly graph: string;
  readonly root: ObjectId;
  readonly tip: ObjectId;
}

const twoCommitsWithGraph = (slug: string): History => {
  const dir = path.join(root, slug);
  runGit(['init', '-q', '-b', 'main', dir]);
  disableAutoMaintenance(dir);
  const env = { ...process.env, ...DATE_ENV };
  for (const message of ['c1', 'c2']) {
    runGit(['-C', dir, 'commit', '-q', '--allow-empty', '-m', message], { env });
  }
  runGit(['-C', dir, 'commit-graph', 'write', '--reachable']);
  const rev = (name: string) => runGit(['-C', dir, 'rev-parse', name]).trim() as ObjectId;
  const graph = path.join(dir, '.git', 'objects', 'info', 'commit-graph');
  chmodSync(graph, 0o644);
  return { dir, graph, root: rev('HEAD~1'), tip: rev('HEAD') };
};

type Damage = (bytes: Uint8Array, history: History) => void;

const restamped = (bytes: Uint8Array): Uint8Array => {
  const trailer = bytes.length - HASH_LENGTH;
  bytes.set(createHash('sha1').update(bytes.subarray(0, trailer)).digest(), trailer);
  return bytes;
};

const entryOf = (bytes: Uint8Array, id: ObjectId): number => {
  const layer = parseCommitGraphLayer(bytes);
  return layer._commitDataOffset + (positionOf(layer, id) as number) * layer._commitDataEntrySize;
};

const setParent1 = (bytes: Uint8Array, id: ObjectId, value: number): void =>
  new DataView(bytes.buffer, bytes.byteOffset).setUint32(entryOf(bytes, id) + HASH_LENGTH, value);

const positionIn = (bytes: Uint8Array, id: ObjectId): number =>
  positionOf(parseCommitGraphLayer(bytes), id) as number;

const ROWS: ReadonlyArray<{
  readonly name: string;
  readonly damage: Damage;
  readonly stamp: boolean;
}> = [
  { name: 'an intact graph', damage: () => undefined, stamp: true },
  {
    name: 'a flipped trailer',
    damage: (bytes) => {
      bytes[bytes.length - 1] = (bytes[bytes.length - 1] as number) ^ 0xff;
    },
    stamp: false,
  },
  {
    name: 'another root tree',
    damage: (bytes, { root: id }) => bytes.fill(0xaa, entryOf(bytes, id), entryOf(bytes, id) + 20),
    stamp: true,
  },
  { name: 'a parent on the root', damage: (b, h) => setParent1(b, h.root, 0), stamp: true },
  { name: 'no parent on the tip', damage: (b, h) => setParent1(b, h.tip, NO_PARENT), stamp: true },
  {
    name: 'the tip as its own parent',
    damage: (b, h) => setParent1(b, h.tip, positionIn(b, h.tip)),
    stamp: true,
  },
  {
    name: 'a parent position past the end',
    damage: (b, h) => setParent1(b, h.tip, 7),
    stamp: true,
  },
  {
    name: 'another committer date',
    damage: (bytes, { tip }) => {
      const view = new DataView(bytes.buffer, bytes.byteOffset);
      view.setUint32(entryOf(bytes, tip) + HASH_LENGTH + 12, 1_700_000_001);
    },
    stamp: true,
  },
  {
    name: 'swapped OIDs',
    damage: (bytes) => {
      const at = parseCommitGraphLayer(bytes)._oidLookupOffset;
      const first = bytes.slice(at, at + HASH_LENGTH);
      bytes.copyWithin(at, at + HASH_LENGTH, at + 2 * HASH_LENGTH);
      bytes.set(first, at + HASH_LENGTH);
    },
    stamp: true,
  },
];

type GraphFinding = Extract<FsckFinding, { type: 'commit-graph-invalid' }>;

const renderLine = (finding: GraphFinding): string => {
  switch (finding.check) {
    case 'checksum':
      return 'the commit-graph file has incorrect checksum and is likely corrupt';
    case 'root-tree':
      return `root tree OID for commit ${finding.id} in commit-graph is ${finding.recorded} != ${finding.actual}`;
    case 'parent':
      return `commit-graph parent for ${finding.id} is ${finding.recorded} != ${finding.actual}`;
    case 'parents-too-long':
      return `commit-graph parent list for commit ${finding.id} is too long`;
    case 'parents-terminate-early':
      return `commit-graph parent list for commit ${finding.id} terminates early`;
    case 'generation':
      return `commit-graph generation for commit ${finding.id} is ${finding.generation} < ${finding.minimum}`;
    case 'commit-date':
      return `commit date for commit ${finding.id} in commit-graph is ${finding.recordedDate} != ${finding.actualDate}`;
    case 'fanout':
      return `commit-graph has incorrect fanout value: fanout[${finding.bucket}] = ${finding.recordedCount} != ${finding.expectedCount}`;
    case 'oid-order':
      return `commit-graph has incorrect OID order: ${finding.previous} then ${finding.id}`;
    case 'graph-unparsable':
      return `failed to parse commit ${finding.id} from commit-graph`;
    case 'invalid-parent-position':
      return `fatal: invalid parent position ${finding.position}`;
    default:
      return JSON.stringify(finding);
  }
};

const isGraphFinding = (finding: FsckFinding): finding is GraphFinding =>
  finding.type === 'commit-graph-invalid';

describe.skipIf(!GIT_AVAILABLE)('Given a two-commit history with a commit-graph', () => {
  describe.each(ROWS)(
    'When the graph carries $name and both tools run fsck',
    ({ name, damage, stamp }) => {
      it(
        'Then tsgit rebuilds every line git prints and sets bit 16 exactly when git does',
        async () => {
          // Arrange
          const history = twoCommitsWithGraph(name.replace(/[^a-z]+/g, '-'));
          const bytes = new Uint8Array(readFileSync(history.graph));
          damage(bytes, history);
          writeFileSync(history.graph, stamp ? restamped(bytes) : bytes);
          const peer = tryRunGitWithExit(['-C', history.dir, 'fsck']);
          const repo = await openRepository({ cwd: history.dir });
          const sut = repo.fsck;

          // Act
          const result = await sut().finally(() => repo.dispose());

          // Assert
          const lines = peer.stderr.split('\n').filter((line) => line.length > 0);
          expect(result.findings.filter(isGraphFinding).map(renderLine)).toEqual(lines);
          expect(result.exitCode & EXIT_COMMIT_GRAPH).toBe(peer.exitCode & EXIT_COMMIT_GRAPH);
        },
        ROW_TIMEOUT,
      );
    },
  );

  describe('When core.commitGraph=false and the graph names a parent on the root', () => {
    it(
      'Then neither tool verifies the graph',
      async () => {
        // Arrange
        const history = twoCommitsWithGraph('disabled');
        const bytes = new Uint8Array(readFileSync(history.graph));
        setParent1(bytes, history.root, 0);
        writeFileSync(history.graph, restamped(bytes));
        runGit(['-C', history.dir, 'config', 'core.commitGraph', 'false']);
        const peer = tryRunGitWithExit(['-C', history.dir, 'fsck']);
        const repo = await openRepository({ cwd: history.dir });
        const sut = repo.fsck;

        // Act
        const result = await sut().finally(() => repo.dispose());

        // Assert
        expect(peer.exitCode).toBe(0);
        expect(result.findings.filter(isGraphFinding)).toEqual([]);
        expect(result.exitCode).toBe(0);
      },
      ROW_TIMEOUT,
    );
  });
});
