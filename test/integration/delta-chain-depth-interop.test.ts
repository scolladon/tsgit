/**
 * Cross-tool interop for hostile delta chains: a crafted pack whose OFS_DELTA
 * names its own offset (base distance zero) must be refused by tsgit exactly
 * where canonical git refuses it, while the otherwise sound base entry stays
 * readable by both.
 *
 * @proves
 *   surface:        readObject
 *   bucket:         cross-tool-interop
 *   unique:         a zero-distance OFS_DELTA is refused by tsgit and git alike (git exits 128)
 *   interopSurface: packfile
 */
import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../src/adapters/memory/memory-adapter.js';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { readBlob } from '../../src/application/primitives/read-blob.js';
import {
  disposePackRegistry,
  readObject,
  readObjectMetadata,
} from '../../src/application/primitives/read-object.js';
import type { TsgitError } from '../../src/domain/error.js';
import type { ObjectId } from '../../src/domain/objects/object-id.js';
import { buildSyntheticPack, ofsChainSpecs } from '../unit/application/primitives/pack-fixture.js';
import {
  GIT_AVAILABLE,
  runGit,
  runGitBytes,
  runGitEnv,
  tryRunGitWithExit,
} from './interop-helpers.js';

const GIT_REFUSAL_EXIT_CODE = 128;
const FIXTURE_TIMEOUT_MS = 60_000;
const GIT_DEFAULT_DEPTH_LIMIT = 50;
const PIN_ONE_FILE_LINES = 2_000;
const PIN_ONE_COMMITS = 100;
const PIN_TWO_VERSIONS = 4_100;
const PIN_TWO_DEPTH_FLOOR = 4_095;
const MAX_FAST_IMPORT_DEPTH = 8_191;
const CRAFTED_CHAIN_DEPTHS = [51, 1_000];
const CHAIN_LENGTH_LINE = /^chain length = (\d+): /gm;

interface InstalledPack {
  readonly dir: string;
  readonly dispose: () => Promise<void>;
}

const installCraftedPack = async (
  packBytes: Uint8Array,
  idxBytes: Uint8Array,
): Promise<InstalledPack> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-delta-depth-'));
  runGit(['init', '-q', '--bare', '-b', 'main', dir]);
  const packDir = path.join(dir, 'objects', 'pack');
  await mkdir(packDir, { recursive: true });
  await writeFile(path.join(packDir, 'pack-crafted.pack'), packBytes);
  await writeFile(path.join(packDir, 'pack-crafted.idx'), idxBytes);
  return { dir, dispose: () => rm(dir, { recursive: true, force: true }) };
};

const longestChain = (dir: string): number => {
  const idx = runGit(['-C', dir, 'rev-parse', '--git-path', 'objects/pack']).trim();
  const packDir = path.isAbsolute(idx) ? idx : path.join(dir, idx);
  const listing = runGit(['-C', dir, 'verify-pack', '-v', ...packIdxPaths(packDir)]);
  return Math.max(...[...listing.matchAll(CHAIN_LENGTH_LINE)].map((m) => Number(m[1])));
};

const packIdxPaths = (packDir: string): string[] =>
  readdirSync(packDir)
    .filter((name) => name.endsWith('.idx'))
    .map((name) => path.join(packDir, name));

const pipeIntoFastImport = (dir: string, streamPath: string, depth: number): void => {
  const fd = openSync(streamPath, 'r');
  try {
    const result = spawnSync('git', ['-C', dir, 'fast-import', '--quiet', `--depth=${depth}`], {
      env: runGitEnv(),
      stdio: [fd, 'ignore', 'inherit'],
    });
    if (result.status !== 0) {
      throw new Error(`git fast-import exited with status ${String(result.status)}`);
    }
  } finally {
    closeSync(fd);
  }
};

const runFastImport = async (dir: string, stream: string, depth: number): Promise<void> => {
  const streamPath = path.join(os.tmpdir(), `tsgit-delta-depth-${path.basename(dir)}.fi`);
  await writeFile(streamPath, stream);
  try {
    pipeIntoFastImport(dir, streamPath, depth);
  } finally {
    await rm(streamPath, { force: true });
  }
};

const dataRecord = (payload: string): string => `data ${Buffer.byteLength(payload)}\n${payload}\n`;

const commitRecord = (mark: number, fileMark: number, message: string, from?: number): string =>
  [
    'commit refs/heads/main',
    `mark :${mark}`,
    'committer T <t@example.com> 1700000000 +0000',
    dataRecord(message).trimEnd(),
    ...(from === undefined ? [] : [`from :${from}`]),
    `M 100644 :${fileMark} file.txt\n`,
  ].join('\n');

const buildVersionedHistoryStream = (): string => {
  const lines = Array.from({ length: PIN_ONE_FILE_LINES }, (_, i) => `line ${i}`);
  const records: string[] = [];
  for (let version = 0; version <= PIN_ONE_COMMITS; version += 1) {
    const body = [version === 0 ? lines[0] : `changed ${version}`, ...lines.slice(1)].join('\n');
    const blobMark = 2 * version + 1;
    const commitMark = 2 * version + 2;
    records.push(`blob\nmark :${blobMark}\n${dataRecord(`${body}\n`)}`);
    records.push(
      commitRecord(commitMark, blobMark, `c${version}`, version === 0 ? undefined : commitMark - 2),
    );
  }
  return records.join('');
};

const buildDeepBlobStream = (): string => {
  const records: string[] = [];
  for (let version = 0; version < PIN_TWO_VERSIONS; version += 1) {
    const body = [
      `version ${version}`,
      'line 1 of the deep chain fixture',
      'line 2 of the deep chain fixture',
    ];
    records.push(`blob\nmark :${version + 1}\n${dataRecord(`${body.join('\n')}\n`)}`);
  }
  records.push(commitRecord(PIN_TWO_VERSIONS + 1, PIN_TWO_VERSIONS, 'deep'));
  return records.join('');
};

describe.skipIf(!GIT_AVAILABLE)('delta chain depth interop', () => {
  describe('Given a pack whose OFS_DELTA has a base distance of zero', () => {
    describe('When git and tsgit read the delta and its base', () => {
      it('Then both refuse the delta and still read the base', async () => {
        // Arrange
        const encoder = new TextEncoder();
        const { packBytes, idxBytes, ids } = await buildSyntheticPack(createMemoryContext(), [
          { kind: 'base', type: 'blob', content: encoder.encode('zero-distance base') },
          {
            kind: 'ofs-delta',
            baseIndex: 0,
            targetContent: encoder.encode('zero-distance target'),
            distanceOverride: 0,
          },
        ]);
        const deltaId = ids[1] as ObjectId;
        const baseId = ids[0] as ObjectId;
        const { dir, dispose } = await installCraftedPack(packBytes, idxBytes);
        const ctx = createNodeContext({ workDir: dir, gitDir: dir, bare: true });

        try {
          // Act
          const gitType = tryRunGitWithExit(['-C', dir, 'cat-file', '-t', deltaId]);
          const gitContent = tryRunGitWithExit(['-C', dir, 'cat-file', '-p', deltaId]);
          const gitBaseType = tryRunGitWithExit(['-C', dir, 'cat-file', '-t', baseId]);
          const caught = await readObject(ctx, deltaId).then(
            () => undefined,
            (error: unknown) => (error as TsgitError).data,
          );

          // Assert
          expect(gitType.exitCode).toBe(GIT_REFUSAL_EXIT_CODE);
          expect(gitContent.exitCode).toBe(GIT_REFUSAL_EXIT_CODE);
          expect(gitBaseType.exitCode).toBe(0);
          expect(gitBaseType.stdout).toBe('blob\n');
          expect(caught?.code).toBe('OBJECT_NOT_FOUND');
          if (caught?.code !== 'OBJECT_NOT_FOUND') {
            expect.fail(`expected OBJECT_NOT_FOUND, got ${String(caught?.code)}`);
          }
          expect(caught.id).toBe(deltaId);
        } finally {
          await disposePackRegistry(ctx);
          await dispose();
        }
      });
    });
  });

  describe('Given a repository packed by fast-import at depth 100', () => {
    describe('When git and tsgit read the blob at the end of the longest chain', () => {
      it(
        'Then the chain is deeper than the default limit and both read the same bytes',
        async () => {
          // Arrange
          const dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-delta-depth-'));
          runGit(['init', '-q', '--bare', '-b', 'main', dir]);
          await runFastImport(dir, buildVersionedHistoryStream(), PIN_ONE_COMMITS);
          const ctx = createNodeContext({ workDir: dir, gitDir: dir, bare: true });

          try {
            const blobId = runGit(['-C', dir, 'rev-parse', 'main:file.txt']).trim() as ObjectId;

            // Act
            const maxChain = longestChain(dir);
            const result = await readBlob(ctx, blobId);

            // Assert
            expect(maxChain).toBeGreaterThan(GIT_DEFAULT_DEPTH_LIMIT);
            expect(result.content).toEqual(
              runGitBytes(['-C', dir, 'cat-file', '-p', 'main:file.txt']),
            );
          } finally {
            await disposePackRegistry(ctx);
            await rm(dir, { recursive: true, force: true });
          }
        },
        FIXTURE_TIMEOUT_MS,
      );
    });
  });

  describe('Given a repository whose blob sits 4099 deltas deep', () => {
    describe('When git and tsgit read the blob and its metadata', () => {
      it(
        'Then both agree on the bytes, the type and the size',
        async () => {
          // Arrange
          const dir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-delta-depth-'));
          runGit(['init', '-q', '--bare', '-b', 'main', dir]);
          await runFastImport(dir, buildDeepBlobStream(), MAX_FAST_IMPORT_DEPTH);
          const ctx = createNodeContext({ workDir: dir, gitDir: dir, bare: true });

          try {
            const blobId = runGit(['-C', dir, 'rev-parse', 'main:file.txt']).trim() as ObjectId;
            const gitSize = Number(runGit(['-C', dir, 'cat-file', '-s', blobId]).trim());

            // Act
            const maxChain = longestChain(dir);
            const blob = await readBlob(ctx, blobId);
            const metadata = await readObjectMetadata(ctx, blobId);

            // Assert
            expect(maxChain).toBeGreaterThan(PIN_TWO_DEPTH_FLOOR);
            expect(blob.content).toEqual(runGitBytes(['-C', dir, 'cat-file', '-p', blobId]));
            expect(metadata).toEqual({ type: 'blob', uncompressedSize: gitSize });
          } finally {
            await disposePackRegistry(ctx);
            await rm(dir, { recursive: true, force: true });
          }
        },
        FIXTURE_TIMEOUT_MS,
      );
    });
  });

  describe.each(CRAFTED_CHAIN_DEPTHS)('Given a crafted OFS_DELTA chain of %i levels', (depth) => {
    describe('When git and tsgit read the tip', () => {
      it('Then both return the same bytes', async () => {
        // Arrange
        const { entries } = ofsChainSpecs(depth, `crafted-${depth}`);
        const { packBytes, idxBytes, ids } = await buildSyntheticPack(
          createMemoryContext(),
          entries,
        );
        const tip = ids.at(-1) as ObjectId;
        const { dir, dispose } = await installCraftedPack(packBytes, idxBytes);
        const ctx = createNodeContext({ workDir: dir, gitDir: dir, bare: true });

        try {
          // Act
          const result = await readBlob(ctx, tip);

          // Assert
          expect(result.content).toEqual(runGitBytes(['-C', dir, 'cat-file', '-p', tip]));
        } finally {
          await disposePackRegistry(ctx);
          await dispose();
        }
      });
    });
  });
});
