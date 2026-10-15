/**
 * Cross-tool interop — index entry path bytes. The state is built with real
 * git, tsgit acts through `openRepository`, and the assertions compare path
 * bytes as hex from `git ls-files -s -z` / `git ls-tree -r -z`.
 *
 * @proves
 *   surface:        index
 *   bucket:         cross-tool-interop
 *   unique:         index entry path bytes round-trip like git
 *   interopSurface: index
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { readIndex } from '../../src/application/primitives/read-index.js';
import { bytesToHex } from '../../src/domain/objects/encoding.js';
import type { AuthorIdentity } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import {
  GIT_AVAILABLE,
  makePeerPair,
  type PeerPair,
  runGit,
  runGitBytes,
  runGitEnv,
} from './interop-helpers.js';

const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const COMMIT_ENV: NodeJS.ProcessEnv = {
  ...runGitEnv(),
  GIT_AUTHOR_NAME: AUTHOR.name,
  GIT_AUTHOR_EMAIL: AUTHOR.email,
  GIT_AUTHOR_DATE: `${AUTHOR.timestamp} ${AUTHOR.timezoneOffset}`,
  GIT_COMMITTER_NAME: AUTHOR.name,
  GIT_COMMITTER_EMAIL: AUTHOR.email,
  GIT_COMMITTER_DATE: `${AUTHOR.timestamp} ${AUTHOR.timezoneOffset}`,
};

const NUL = 0x00;
const TAB = 0x09;
const BOM_DIR_HEX = 'efbbbf612f78';
const Z_HEX = '7a';

const hex = (bytes: Uint8Array): string => bytesToHex(bytes);

const pathHexOfRecords = (records: Uint8Array): string[] => {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < records.length; i++) {
    if (records[i] !== NUL) continue;
    const record = records.subarray(start, i);
    out.push(hex(record.subarray(record.indexOf(TAB) + 1)));
    start = i + 1;
  }
  return out;
};

const lsFilesPathHex = (dir: string): string[] =>
  pathHexOfRecords(runGitBytes(['-C', dir, 'ls-files', '-s', '-z']));

const lsTreePathHex = (dir: string, rev: string): string[] =>
  pathHexOfRecords(runGitBytes(['-C', dir, 'ls-tree', '-r', '-z', rev]));

const FF_TXT = Uint8Array.of(0xff, 0x2e, 0x74, 0x78, 0x74);
const B_SLASH_C3 = Uint8Array.of(0x62, 0x2f, 0xc3);
const D_SLASH_FF = Uint8Array.of(0x64, 0x2f, 0xff);
const REGULAR_MODE = '100644';

const hashBlob = (dir: string, content: string): string =>
  runGit(['-C', dir, 'hash-object', '-w', '--stdin'], { input: content }).trim();

const stageRaw = (
  dir: string,
  rows: ReadonlyArray<{ mode: string; oid: string; path: Uint8Array }>,
): void => {
  const encoder = new TextEncoder();
  const chunks = rows.flatMap((row) => [
    encoder.encode(`${row.mode} ${row.oid}\t`),
    row.path,
    Uint8Array.of(NUL),
  ]);
  const input = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    input.set(chunk, offset);
    offset += chunk.length;
  }
  runGit(['-C', dir, 'update-index', '-z', '--index-info'], { input });
};

describe.skipIf(!GIT_AVAILABLE)(
  'index path bytes interop — leading BOM',
  { timeout: 60_000 },
  () => {
    let pair: PeerPair;
    let repo: Repository;

    const git = (...args: ReadonlyArray<string>): string =>
      runGit(['-C', pair.peer, ...args], { env: COMMIT_ENV });

    const buildBomState = (): void => {
      mkdirSync(path.join(pair.peer, '\uFEFFa'));
      writeFileSync(path.join(pair.peer, '\uFEFFa', 'x'), 'x\n');
      writeFileSync(path.join(pair.peer, 'z'), 'z\n');
      git('add', '.');
      git('commit', '-q', '-m', 'seed');
    };

    beforeEach(async () => {
      pair = await makePeerPair('index-path-bytes');
      runGit(['init', '-q', '-b', 'main', pair.peer]);
      runGit(['-C', pair.peer, 'config', 'user.name', 'Ada']);
      runGit(['-C', pair.peer, 'config', 'user.email', 'ada@example.com']);
      repo = await openRepository({ cwd: pair.peer });
    });

    afterEach(async () => {
      await repo.dispose();
      await pair.dispose();
    });

    describe('Given git committed a BOM-prefixed directory', () => {
      it('Then readIndex decodes the entry paths with the BOM kept', async () => {
        // Arrange
        buildBomState();
        const ctx = createNodeContext({ workDir: pair.peer });

        // Act
        const sut = await readIndex(ctx);

        // Assert
        expect(sut.entries.map((e) => hex(new TextEncoder().encode(e.path)))).toEqual([
          Z_HEX,
          BOM_DIR_HEX,
        ]);
      });

      it('Then add of another file keeps the BOM entry bytes', async () => {
        // Arrange
        buildBomState();
        writeFileSync(path.join(pair.peer, 'z'), 'z2\n');

        // Act
        await repo.add(['z']);

        // Assert
        expect(lsFilesPathHex(pair.peer)).toEqual([Z_HEX, BOM_DIR_HEX]);
        expect(() => git('fsck')).not.toThrow();
        expect(git('status', '--porcelain', '-z')).toBe('M  z\0');
      });

      it('Then commit keeps the BOM tree entry bytes', async () => {
        // Arrange
        buildBomState();
        writeFileSync(path.join(pair.peer, 'z'), 'z2\n');
        await repo.add(['z']);

        // Act
        await repo.commit({ message: 'next', author: AUTHOR, committer: AUTHOR });

        // Assert
        expect(lsTreePathHex(pair.peer, 'HEAD')).toEqual([Z_HEX, BOM_DIR_HEX]);
        expect(git('diff-tree', '-r', '--name-status', 'HEAD~1', 'HEAD')).toBe('M\tz\n');
      });

      it('Then status is clean for BOM names at any depth', async () => {
        // Arrange
        buildBomState();
        mkdirSync(path.join(pair.peer, 'sub'));
        writeFileSync(path.join(pair.peer, 'sub', '\uFEFFy'), 'y\n');
        git('add', '.');
        git('commit', '-q', '-m', 'second');

        // Act
        const sut = await repo.status();

        // Assert
        expect(sut.clean).toBe(true);
      });

      it('Then rm --cached removes the BOM entry by its BOM name', async () => {
        // Arrange
        buildBomState();

        // Act
        const sut = await repo.rm(['\uFEFFa/x'], { cached: true });

        // Assert
        expect(sut.removed).toEqual(['\uFEFFa/x']);
        expect(lsFilesPathHex(pair.peer)).not.toContain(BOM_DIR_HEX);
      });
    });
  },
);

describe.skipIf(!GIT_AVAILABLE)(
  'index path bytes interop — non-UTF-8 names',
  { timeout: 60_000 },
  () => {
    let pair: PeerPair;
    let repo: Repository;

    const git = (...args: ReadonlyArray<string>): string =>
      runGit(['-C', pair.peer, ...args], { env: COMMIT_ENV });

    beforeEach(async () => {
      pair = await makePeerPair('index-path-bytes-raw');
      runGit(['init', '-q', '-b', 'main', pair.peer]);
      runGit(['-C', pair.peer, 'config', 'user.name', 'Ada']);
      runGit(['-C', pair.peer, 'config', 'user.email', 'ada@example.com']);
      repo = await openRepository({ cwd: pair.peer });
    });

    afterEach(async () => {
      await repo.dispose();
      await pair.dispose();
    });

    describe('Given git committed non-UTF-8 names next to z', () => {
      const buildRawState = (): void => {
        const blob = hashBlob(pair.peer, 'raw\n');
        stageRaw(pair.peer, [
          { mode: REGULAR_MODE, oid: blob, path: FF_TXT },
          { mode: REGULAR_MODE, oid: blob, path: B_SLASH_C3 },
        ]);
        writeFileSync(path.join(pair.peer, 'z'), 'z\n');
        git('add', 'z');
        git('commit', '-q', '-m', 'seed');
      };

      it('Then readIndex keeps the raw bytes and the decoded view', async () => {
        // Arrange
        buildRawState();
        const ctx = createNodeContext({ workDir: pair.peer });

        // Act
        const sut = await readIndex(ctx);

        // Assert
        const lossy = sut.entries.find(
          (e) => e.pathBytes !== undefined && e.path.startsWith('\uFFFD'),
        );
        expect(hex(lossy?.pathBytes ?? new Uint8Array())).toBe('ff2e747874');
        expect(lossy?.path).toBe('\uFFFD.txt');
      });

      it('Then add of z keeps every raw name byte-for-byte', async () => {
        // Arrange
        buildRawState();
        writeFileSync(path.join(pair.peer, 'z'), 'z2\n');

        // Act
        await repo.add(['z']);

        // Assert
        expect(lsFilesPathHex(pair.peer)).toEqual(['622fc3', Z_HEX, 'ff2e747874']);
        expect(() => git('fsck')).not.toThrow();
      });

      it('Then commit names the tree entries by their raw bytes', async () => {
        // Arrange
        buildRawState();
        writeFileSync(path.join(pair.peer, 'z'), 'z2\n');
        await repo.add(['z']);

        // Act
        await repo.commit({ message: 'second', author: AUTHOR });

        // Assert
        expect(lsTreePathHex(pair.peer, 'HEAD')).toEqual(['622fc3', Z_HEX, 'ff2e747874']);
        expect(git('diff-tree', '-r', '--name-status', 'HEAD~1', 'HEAD')).toBe('M\tz\n');
        expect(() => git('fsck')).not.toThrow();
      });
    });

    describe('Given a committed tree naming a non-UTF-8 entry inside a directory', () => {
      it('Then add elsewhere keeps the index and its tree in agreement', async () => {
        // Arrange
        const blob = hashBlob(pair.peer, 'raw\n');
        mkdirSync(path.join(pair.peer, 'd'));
        mkdirSync(path.join(pair.peer, 'e'));
        writeFileSync(path.join(pair.peer, 'd', 'y'), 'y\n');
        writeFileSync(path.join(pair.peer, 'e', 'f'), 'f\n');
        git('add', '.');
        stageRaw(pair.peer, [{ mode: REGULAR_MODE, oid: blob, path: D_SLASH_FF }]);
        git('commit', '-q', '-m', 'seed');
        writeFileSync(path.join(pair.peer, 'e', 'f'), 'f2\n');

        // Act
        await repo.add(['e/f']);

        // Assert
        expect(lsFilesPathHex(pair.peer)).toEqual(['642f79', '642fff', '652f66']);
        expect(() => git('fsck', '--cache')).not.toThrow();
        const tree = git('write-tree').trim();
        expect(lsTreePathHex(pair.peer, tree)).toEqual(lsFilesPathHex(pair.peer));
      });
    });
  },
);

const REPLACEMENT_CHAR_TXT = Uint8Array.of(0xef, 0xbf, 0xbd, 0x2e, 0x74, 0x78, 0x74);
const BOM_Z = Uint8Array.of(0xef, 0xbb, 0xbf, 0x7a);

const oidByPathHex = (dir: string): Record<string, string> => {
  const rows = new TextDecoder('latin1')
    .decode(runGitBytes(['-C', dir, 'ls-files', '-s', '-z']))
    .split('\0')
    .filter((row) => row !== '');
  return Object.fromEntries(
    rows.map((row) => {
      const [meta = '', name = ''] = row.split('\t');
      const oid = meta.split(' ')[1] ?? '';
      return [hex(Uint8Array.from(name, (c) => c.charCodeAt(0))), oid];
    }),
  );
};

describe.skipIf(!GIT_AVAILABLE)(
  'index path bytes interop — names whose decoded paths collide',
  { timeout: 60_000 },
  () => {
    let pair: PeerPair;
    let repo: Repository;
    let blobX: string;
    let blobY: string;

    const git = (...args: ReadonlyArray<string>): string =>
      runGit(['-C', pair.peer, ...args], { env: COMMIT_ENV });

    beforeEach(async () => {
      pair = await makePeerPair('index-path-bytes-collide');
      runGit(['init', '-q', '-b', 'main', pair.peer]);
      runGit(['-C', pair.peer, 'config', 'user.name', 'Ada']);
      runGit(['-C', pair.peer, 'config', 'user.email', 'ada@example.com']);
      repo = await openRepository({ cwd: pair.peer });
      blobX = hashBlob(pair.peer, 'x\n');
      blobY = hashBlob(pair.peer, 'y\n');
      stageRaw(pair.peer, [
        { mode: REGULAR_MODE, oid: blobX, path: FF_TXT },
        { mode: REGULAR_MODE, oid: blobY, path: REPLACEMENT_CHAR_TXT },
        { mode: REGULAR_MODE, oid: blobY, path: BOM_Z },
      ]);
      writeFileSync(path.join(pair.peer, 'z'), 'z\n');
      git('add', 'z');
    });

    afterEach(async () => {
      await repo.dispose();
      await pair.dispose();
    });

    const EXPECTED_HEX = ['7a', 'efbbbf7a', 'efbfbd2e747874', 'ff2e747874'];

    describe('Given git staged z, the BOM z, the replacement-character name and the raw 0xff name', () => {
      it('Then readIndex lists the four entries with their raw bytes', async () => {
        // Arrange
        const ctx = createNodeContext({ workDir: pair.peer });

        // Act
        const sut = await readIndex(ctx);

        // Assert
        const rawBytes = sut.entries.map((e) =>
          hex(e.pathBytes ?? new TextEncoder().encode(e.path)),
        );
        expect(rawBytes).toEqual(EXPECTED_HEX);
      });

      it('Then add of a modified z keeps the four entries and their blobs', async () => {
        // Arrange
        writeFileSync(path.join(pair.peer, 'z'), 'z2\n');

        // Act
        await repo.add(['z']);

        // Assert
        expect(lsFilesPathHex(pair.peer)).toEqual(EXPECTED_HEX);
        const oids = oidByPathHex(pair.peer);
        expect(oids.ff2e747874).toBe(blobX);
        expect(oids.efbfbd2e747874).toBe(blobY);
        expect(oids.efbbbf7a).toBe(blobY);
        expect(() => git('fsck')).not.toThrow();
      });
    });
  },
);
