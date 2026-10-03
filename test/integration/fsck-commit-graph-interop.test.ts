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
    case 'chain-unopenable':
      return `fatal: could not open commit-graph chain '${finding.artefact}': Not a directory`;
    default:
      return JSON.stringify(finding);
  }
};

const isGraphFinding = (finding: FsckFinding): finding is GraphFinding =>
  finding.type === 'commit-graph-invalid';

type LoadFailure = Extract<GraphFinding, { check: 'load-failure' }>['failure'];
const hex = (value: number): string => value.toString(16);
const REQUIRED_NAMES = {
  'oid-fanout': 'OID fanout',
  'oid-lookup': 'OID lookup',
  'commit-data': 'commit data',
} as const;
const PROBLEM_LINES = {
  'oid-fanout': 'commit-graph oid fanout chunk is wrong size',
  'oid-lookup': 'commit-graph OID lookup chunk is the wrong size',
  'commit-data': 'commit-graph commit data chunk is wrong size',
} as const;

const requiredLines = (failure: Extract<LoadFailure, { kind: 'required-chunk' }>): string[] => {
  const required = `error: commit-graph required ${REQUIRED_NAMES[failure.chunk]} chunk missing or corrupted`;
  if (failure.problem === 'missing') return [required];
  const cause =
    failure.problem === 'out-of-order'
      ? 'commit-graph fanout values out of order'
      : PROBLEM_LINES[failure.chunk];
  return [`error: ${cause}`, required];
};

const renderLoad = (failure: LoadFailure): string[] => {
  switch (failure.kind) {
    case 'too-small':
      return ['error: commit-graph file is too small'];
    case 'signature':
      return [
        `error: commit-graph signature ${hex(failure.found).toUpperCase()} does not match signature 43475048`,
      ];
    case 'version':
      return [`error: commit-graph version ${hex(failure.found)} does not match version 1`];
    case 'hash-version':
      return [
        `error: commit-graph hash version ${failure.found} does not match version ${failure.expected}`,
      ];
    case 'too-small-for-chunks':
      return [`error: commit-graph file is too small to hold ${failure.chunkCount} chunks`];
    case 'early-terminator':
      return ['error: terminating chunk id appears earlier than expected'];
    case 'improper-offsets':
      return [`error: improper chunk offset(s) ${hex(failure.offset)} and ${hex(failure.next)}`];
    case 'duplicate-chunk':
      return [`error: duplicate chunk ID ${hex(failure.chunkId)} found`];
    case 'final-chunk-id':
      return [`error: final chunk has non-zero id ${hex(failure.chunkId)}`];
    case 'required-chunk':
      return requiredLines(failure);
    default:
      return [JSON.stringify(failure)];
  }
};

const renameChunk = (bytes: Uint8Array, from: string, to: string): Uint8Array => {
  const table = new TextDecoder().decode(bytes.subarray(0, 8 + 12 * (bytes[6] as number)));
  bytes.set(new TextEncoder().encode(to), table.indexOf(from));
  return bytes;
};

const setRowOffset = (bytes: Uint8Array, row: number, delta: number): Uint8Array => {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  view.setUint32(8 + row * 12 + 8, view.getUint32(8 + row * 12 + 8) + delta);
  return bytes;
};

const LOAD_ROWS: ReadonlyArray<{
  readonly name: string;
  readonly damage: (b: Uint8Array) => Uint8Array;
}> = [
  { name: 'a file too small', damage: (b) => b.subarray(0, 1000) },
  { name: 'another signature', damage: (b) => b.fill(0x58, 0, 1) },
  { name: 'another version', damage: (b) => b.fill(9, 4, 5) },
  { name: 'a SHA-256 hash version', damage: (b) => b.fill(2, 5, 6) },
  { name: 'too many chunks', damage: (b) => b.fill(200, 6, 7) },
  { name: 'an early terminator', damage: (b) => b.fill(0, 8 + 12, 8 + 12 + 4) },
  { name: 'a chunk ending before it starts', damage: (b) => setRowOffset(b, 2, -2000) },
  { name: 'a duplicate chunk', damage: (b) => renameChunk(b, 'CDAT', 'OIDL') },
  {
    name: 'a non-zero final id',
    damage: (b) => b.fill(0x41, 8 + 12 * (b[6] as number), 12 + 12 * (b[6] as number)),
  },
  { name: 'no OID fanout', damage: (b) => renameChunk(b, 'OIDF', 'XXXX') },
  { name: 'no OID lookup', damage: (b) => renameChunk(b, 'OIDL', 'XXXX') },
  { name: 'no commit data', damage: (b) => renameChunk(b, 'CDAT', 'XXXX') },
  { name: 'a short fanout', damage: (b) => setRowOffset(b, 1, -4) },
  {
    name: 'a decreasing fanout',
    damage: (b) => b.fill(0x7f, 8 + 12 * ((b[6] as number) + 1), 9 + 12 * ((b[6] as number) + 1)),
  },
  { name: 'a ragged OID lookup', damage: (b) => setRowOffset(b, 2, -1) },
  { name: 'a ragged commit data', damage: (b) => setRowOffset(b, 3, -1) },
];

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

  describe.each(LOAD_ROWS)(
    'When the graph carries $name and git cannot load it',
    ({ name, damage }) => {
      it(
        'Then tsgit names the refusal git verify prints, with bit 16',
        async () => {
          // Arrange
          const history = twoCommitsWithGraph(`load-${name.replace(/[^a-z0-9]+/g, '-')}`);
          writeFileSync(history.graph, damage(new Uint8Array(readFileSync(history.graph))));
          const peer = tryRunGitWithExit(['-C', history.dir, 'commit-graph', 'verify']);
          const repo = await openRepository({ cwd: history.dir });
          const sut = repo.fsck;

          // Act
          const result = await sut().finally(() => repo.dispose());

          // Assert
          const lines = peer.stderr.split('\n').filter((line) => line.length > 0);
          const rendered = result.findings
            .filter(isGraphFinding)
            .flatMap((finding) =>
              finding.check === 'load-failure'
                ? renderLoad(finding.failure)
                : [renderLine(finding)],
            );
          expect(rendered).toEqual(lines);
          expect(peer.exitCode).toBe(1);
          expect(result.exitCode & EXIT_COMMIT_GRAPH).toBe(EXIT_COMMIT_GRAPH);
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

  describe('When info/commit-graphs is a file and both tools run fsck', () => {
    it(
      'Then tsgit reports the unopenable chain git dies on, with bit 16',
      async () => {
        // Arrange
        const history = twoCommitsWithGraph('chain-not-a-directory');
        rmSync(history.graph);
        writeFileSync(path.join(history.dir, '.git', 'objects', 'info', 'commit-graphs'), 'x');
        const peer = tryRunGitWithExit(['-C', history.dir, 'fsck']);
        const repo = await openRepository({ cwd: history.dir });
        const sut = repo.fsck;

        // Act
        const result = await sut().finally(() => repo.dispose());

        // Assert
        const lines = peer.stderr.split('\n').filter((line) => line.length > 0);
        const relative = result.findings
          .filter(isGraphFinding)
          .map((finding) =>
            renderLine({ ...finding, artefact: path.relative(history.dir, finding.artefact) }),
          );
        expect(relative).toEqual(lines);
        expect(result.exitCode & EXIT_COMMIT_GRAPH).toBe(peer.exitCode & EXIT_COMMIT_GRAPH);
      },
      ROW_TIMEOUT,
    );
  });
});
