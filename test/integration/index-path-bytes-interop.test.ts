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
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { readIndex } from '../../src/application/primitives/read-index.js';
import type { AuthorIdentity } from '../../src/domain/objects/index.js';
import { openRepository } from '../../src/index.node.js';
import type { Repository } from '../../src/repository.js';
import {
  GIT_AVAILABLE,
  hashBlob,
  hex,
  lsFilesPathHex,
  lsTreePathHex,
  makePeerPair,
  NUL,
  type PeerPair,
  runGit,
  runGitBytes,
  runGitEnv,
  stageRaw,
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

const BOM_DIR_HEX = 'efbbbf612f78';
const Z_HEX = '7a';

const FF_TXT = Uint8Array.of(0xff, 0x2e, 0x74, 0x78, 0x74);
const B_SLASH_C3 = Uint8Array.of(0x62, 0x2f, 0xc3);
const D_SLASH_FF = Uint8Array.of(0x64, 0x2f, 0xff);
const REGULAR_MODE = '100644';

const STATUS_FIELDS_BEFORE_PATH = 8;

const deletedPathHex = (dir: string): string[] =>
  Buffer.from(runGitBytes(['-C', dir, 'status', '--porcelain=v2', '-z']))
    .toString('latin1')
    .split('\0')
    .filter((record) => record.startsWith('1 .D '))
    .map((record) =>
      Buffer.from(record.split(' ').slice(STATUS_FIELDS_BEFORE_PATH).join(' '), 'latin1').toString(
        'hex',
      ),
    );

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
      describe('When the index is read', () => {
        it('Then readIndex decodes the entry paths with the BOM kept', async () => {
          // Arrange
          buildBomState();
          const ctx = createNodeContext({ workDir: pair.peer });

          // Act
          const result = await readIndex(ctx);

          // Assert
          expect(result.entries.map((e) => hex(new TextEncoder().encode(e.path)))).toEqual([
            Z_HEX,
            BOM_DIR_HEX,
          ]);
        });
      });

      describe('When another file is added', () => {
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
      });

      describe('When the staged change is committed', () => {
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
      });

      describe('When status runs', () => {
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
      });

      describe('When rm --cached runs', () => {
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

      describe('When the index is read', () => {
        it('Then readIndex keeps the raw bytes and the decoded view', async () => {
          // Arrange
          buildRawState();
          const ctx = createNodeContext({ workDir: pair.peer });

          // Act
          const result = await readIndex(ctx);

          // Assert
          const lossy = result.entries.find(
            (e) => e.pathBytes !== undefined && e.path.startsWith('\uFFFD'),
          );
          expect(hex(lossy?.pathBytes ?? new Uint8Array())).toBe('ff2e747874');
          expect(lossy?.path).toBe('\uFFFD.txt');
        });
      });

      describe('When z is added', () => {
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
      });

      describe('When the staged change is committed', () => {
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
    });

    describe('Given a committed tree naming a non-UTF-8 entry inside a directory', () => {
      describe('When another file is added', () => {
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
      describe('When the index is read', () => {
        it('Then readIndex lists the four entries with their raw bytes', async () => {
          // Arrange
          const ctx = createNodeContext({ workDir: pair.peer });

          // Act
          const result = await readIndex(ctx);

          // Assert
          const rawBytes = result.entries.map((e) =>
            hex(e.pathBytes ?? new TextEncoder().encode(e.path)),
          );
          expect(rawBytes).toEqual(EXPECTED_HEX);
        });
      });

      describe('When a modified z is added', () => {
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
    });
  },
);

describe.skipIf(!GIT_AVAILABLE)(
  'index path bytes interop — reset rebuilds the index from tree names',
  { timeout: 60_000 },
  () => {
    let pair: PeerPair;
    let repo: Repository;

    const git = (...args: ReadonlyArray<string>): string =>
      runGit(['-C', pair.peer, ...args], { env: COMMIT_ENV });

    beforeEach(async () => {
      pair = await makePeerPair('index-path-bytes-reset');
      runGit(['init', '-q', '-b', 'main', pair.peer]);
      runGit(['-C', pair.peer, 'config', 'user.name', 'Ada']);
      runGit(['-C', pair.peer, 'config', 'user.email', 'ada@example.com']);
      repo = await openRepository({ cwd: pair.peer });
    });

    afterEach(async () => {
      await repo.dispose();
      await pair.dispose();
    });

    describe('Given HEAD holds a non-UTF-8 name and a BOM name and the index is empty', () => {
      describe('When reset --mixed runs', () => {
        it('Then reset --mixed restores both names byte-for-byte', async () => {
          // Arrange
          const blob = hashBlob(pair.peer, 'raw\n');
          stageRaw(pair.peer, [{ mode: REGULAR_MODE, oid: blob, path: FF_TXT }]);
          writeFileSync(path.join(pair.peer, '\uFEFFb'), 'b\n');
          git('add', '\uFEFFb');
          git('commit', '-q', '-m', 'seed');
          git('rm', '-r', '--cached', '-q', '.');

          // Act
          await repo.reset({ mode: 'mixed', rev: 'HEAD' });

          // Assert
          expect(lsFilesPathHex(pair.peer)).toEqual(['efbbbf62', 'ff2e747874']);
        });
      });
    });

    describe('Given a changed non-UTF-8 directory between two commits', () => {
      describe('When reset --mixed HEAD~1 runs', () => {
        it('Then reset --mixed HEAD~1 rebuilds an index whose tree equals the target tree', async () => {
          // Arrange
          const blobA = hashBlob(pair.peer, 'a\n');
          const blobB = hashBlob(pair.peer, 'b\n');
          const dirX = Uint8Array.of(0xff, 0x2f, 0x78);
          stageRaw(pair.peer, [
            { mode: REGULAR_MODE, oid: blobA, path: dirX },
            { mode: REGULAR_MODE, oid: blobA, path: Uint8Array.of(0x79) },
          ]);
          git('commit', '-q', '-m', 'one');
          stageRaw(pair.peer, [{ mode: REGULAR_MODE, oid: blobB, path: dirX }]);
          git('commit', '-q', '-m', 'two');
          const targetTree = git('rev-parse', 'HEAD~1^{tree}').trim();

          // Act
          await repo.reset({ mode: 'mixed', rev: 'HEAD~1' });

          // Assert
          expect(git('write-tree').trim()).toBe(targetTree);
          expect(lsFilesPathHex(pair.peer)).toEqual(['79', 'ff2f78']);
          expect(oidByPathHex(pair.peer).ff2f78).toBe(blobA);
        });
      });
    });
  },
);

describe.skipIf(!GIT_AVAILABLE)(
  'index path bytes interop — lossy entries on disk',
  { timeout: 60_000 },
  () => {
    const U_FILE = '�.txt';
    const U_HEX = 'efbfbd2e747874';
    const L_HEX = 'ff2e747874';
    const D_FF_HEX = '642fff';
    let pair: PeerPair;
    let repo: Repository;

    const git = (...args: ReadonlyArray<string>): string =>
      runGit(['-C', pair.peer, ...args], { env: COMMIT_ENV });

    const seedLossyTwins = (opts: { readonly lossyBlob?: string } = {}): void => {
      const lossyBlob = hashBlob(pair.peer, opts.lossyBlob ?? 'l\n');
      writeFileSync(path.join(pair.peer, 'z'), 'z\n');
      writeFileSync(path.join(pair.peer, U_FILE), 'u\n');
      git('add', 'z', U_FILE);
      stageRaw(pair.peer, [
        { mode: REGULAR_MODE, oid: lossyBlob, path: FF_TXT },
        { mode: REGULAR_MODE, oid: lossyBlob, path: D_SLASH_FF },
      ]);
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

    describe('Given a lossy entry and its UTF-8 twin both tracked', () => {
      describe('When status runs', () => {
        it('Then only the lossy entries read as deleted from the working tree', async () => {
          // Arrange
          seedLossyTwins();

          // Act
          const result = await repo.status();

          // Assert
          expect(result.changes.map((c) => [c.path, c.unstaged])).toEqual([
            ['d/�', 'deleted'],
            [U_FILE, 'deleted'],
          ]);
        });
      });

      describe('When status runs on the clean twin repo', () => {
        it('Then no change is staged and git agrees on the two unstaged deletions', async () => {
          // Arrange
          seedLossyTwins();

          // Act
          const result = await repo.status();

          // Assert
          const gitRecords = git('status', '--porcelain=v2', '-z').split('\0').filter(Boolean);
          expect(result.changes.filter((c) => c.staged !== undefined)).toEqual([]);
          expect(result.changes.map((c) => [c.path, c.unstaged])).toEqual([
            ['d/\uFFFD', 'deleted'],
            [U_FILE, 'deleted'],
          ]);
          expect(gitRecords.map((record) => record.slice(0, 4))).toEqual(['1 .D', '1 .D']);
        });
      });

      describe('When add --all runs', () => {
        it('Then both lossy entries leave the index', async () => {
          // Arrange
          seedLossyTwins();

          // Act
          await repo.add([], { all: true });

          // Assert
          expect(lsFilesPathHex(pair.peer)).toEqual([Z_HEX, U_HEX]);
        });
      });

      describe('When add names the U+FFFD literal after U changed', () => {
        it('Then U is restaged and the lossy entry keeps its bytes', async () => {
          // Arrange
          seedLossyTwins();
          writeFileSync(path.join(pair.peer, U_FILE), 'u2\n');

          // Act
          await repo.add([U_FILE]);

          // Assert
          expect(lsFilesPathHex(pair.peer)).toEqual([D_FF_HEX, Z_HEX, U_HEX, L_HEX]);
          expect(git('status', '--porcelain', '-z', '--', U_FILE)).toBe(`M  ${U_FILE}\0`);
        });
      });

      describe('When add names the glob *.txt after U changed', () => {
        it('Then the lossy match is staged as removed and U restaged', async () => {
          // Arrange
          seedLossyTwins();
          writeFileSync(path.join(pair.peer, U_FILE), 'u2\n');

          // Act
          const result = await repo.add(['*.txt']);

          // Assert
          expect(result.removed).toEqual([U_FILE]);
          expect(lsFilesPathHex(pair.peer)).toEqual([D_FF_HEX, Z_HEX, U_HEX]);
        });
      });

      describe('When rm names the glob *.txt without cached', () => {
        it('Then both matching entries leave the index and only the U+FFFD file is unlinked', async () => {
          // Arrange
          seedLossyTwins();
          writeFileSync(path.join(pair.peer, U_FILE), 'u\n');

          // Act
          const result = await repo.rm(['*.txt']);

          // Assert
          expect(result.removed).toEqual([U_FILE, U_FILE]);
          expect(lsFilesPathHex(pair.peer)).toEqual([D_FF_HEX, Z_HEX]);
          expect(existsSync(path.join(pair.peer, U_FILE))).toBe(false);
        });
      });

      describe('When add --renormalize runs', () => {
        it('Then it rejects PATHSPEC_NO_MATCH and leaves the index unchanged', async () => {
          // Arrange
          seedLossyTwins();
          const before = lsFilesPathHex(pair.peer);
          let code: string | undefined;

          // Act
          try {
            await repo.add(['.'], { renormalize: true });
          } catch (error) {
            code = (error as { data?: { code?: string } }).data?.code;
          }

          // Assert
          expect(code).toBe('PATHSPEC_NO_MATCH');
          expect(lsFilesPathHex(pair.peer)).toEqual(before);
        });
      });

      describe('When stash push runs after a tracked change', () => {
        it('Then the stash work tree records the lossy paths deleted', async () => {
          // Arrange
          seedLossyTwins();
          writeFileSync(path.join(pair.peer, 'z'), 'changed\n');

          // Act
          await repo.stash.push();

          // Assert
          expect(lsTreePathHex(pair.peer, 'stash@{0}')).toEqual([Z_HEX, U_HEX]);
        });
      });
    });

    describe('Given HEAD holding only the UTF-8 twin and the index also holding the lossy entry', () => {
      describe('When checkout restores the well-formed U+FFFD name from HEAD', () => {
        it('Then the lossy index entry survives and the twin holds its committed content', async () => {
          // Arrange
          writeFileSync(path.join(pair.peer, 'z'), 'z\n');
          writeFileSync(path.join(pair.peer, U_FILE), 'u\n');
          git('add', 'z', U_FILE);
          git('commit', '-q', '-m', 'seed');
          stageRaw(pair.peer, [
            { mode: REGULAR_MODE, oid: hashBlob(pair.peer, 'l\n'), path: FF_TXT },
          ]);
          writeFileSync(path.join(pair.peer, U_FILE), 'modified\n');
          const before = lsFilesPathHex(pair.peer);

          // Act
          await repo.checkout({ paths: [U_FILE], source: 'HEAD' });

          // Assert
          expect(before).toContain(L_HEX);
          expect(readFileSync(path.join(pair.peer, U_FILE), 'utf8')).toBe('u\n');
          expect(lsFilesPathHex(pair.peer)).toEqual(before);
        });
      });
    });

    describe('Given a lossy entry and its UTF-8 twin both tracked', () => {
      describe('When reset --hard HEAD runs', () => {
        it('Then the twin keeps its content, no lossy name is written and the index is unchanged', async () => {
          // Arrange
          seedLossyTwins();
          const before = lsFilesPathHex(pair.peer);

          // Act
          await repo.reset({ mode: 'hard', rev: 'HEAD' });

          // Assert
          expect(readFileSync(path.join(pair.peer, U_FILE), 'utf8')).toBe('u\n');
          expect(existsSync(path.join(pair.peer, 'd'))).toBe(false);
          expect(lsFilesPathHex(pair.peer)).toEqual(before);
          expect(deletedPathHex(pair.peer).sort()).toEqual([D_FF_HEX, L_HEX]);
        });
      });

      describe('When checkout restores *.txt from HEAD after the twin changed', () => {
        it('Then the twin holds its committed content and the index bytes are unchanged', async () => {
          // Arrange
          seedLossyTwins();
          writeFileSync(path.join(pair.peer, U_FILE), 'modified\n');
          const before = lsFilesPathHex(pair.peer);

          // Act
          await repo.checkout({ paths: ['*.txt'], source: 'HEAD' });

          // Assert
          expect(readFileSync(path.join(pair.peer, U_FILE), 'utf8')).toBe('u\n');
          expect(lsFilesPathHex(pair.peer)).toEqual(before);
        });
      });

      describe('When checkout restores the well-formed U+FFFD name from HEAD after the twin changed', () => {
        it('Then the twin holds its committed content and the index bytes are unchanged', async () => {
          // Arrange
          seedLossyTwins();
          writeFileSync(path.join(pair.peer, U_FILE), 'modified\n');
          const before = lsFilesPathHex(pair.peer);

          // Act
          await repo.checkout({ paths: [U_FILE], source: 'HEAD' });

          // Assert
          expect(readFileSync(path.join(pair.peer, U_FILE), 'utf8')).toBe('u\n');
          expect(lsFilesPathHex(pair.peer)).toEqual(before);
        });
      });

      describe('When checkout switches to a branch adding another lossy name', () => {
        it('Then the index lists the new bytes and no decoded name is written', async () => {
          // Arrange
          seedLossyTwins();
          const blob = hashBlob(pair.peer, 'n\n');
          stageRaw(pair.peer, [{ mode: REGULAR_MODE, oid: blob, path: Uint8Array.of(0x6e, 0xfe) }]);
          git('commit', '-q', '-m', 'add n');
          git('branch', 'side');
          git('reset', '-q', '--mixed', 'HEAD~1');

          // Act
          await repo.checkout({ rev: 'side' });

          // Assert
          expect(lsFilesPathHex(pair.peer)).toContain('6efe');
          expect(existsSync(path.join(pair.peer, 'n\uFFFD'))).toBe(false);
        });
      });
    });

    describe('Given a lossy entry and its UTF-8 twin both tracked', () => {
      describe('When rm --cached names the twin by its U+FFFD spelling', () => {
        it('Then the twin leaves the index and the lossy entry stays', async () => {
          // Arrange
          seedLossyTwins();

          // Act
          await repo.rm(['\uFFFD.txt'], { cached: true });

          // Assert
          expect(lsFilesPathHex(pair.peer)).toEqual([D_FF_HEX, Z_HEX, L_HEX]);
        });
      });

      describe('When rm --cached names *.txt', () => {
        it('Then both entries leave the index', async () => {
          // Arrange
          seedLossyTwins();

          // Act
          await repo.rm(['*.txt'], { cached: true });

          // Assert
          expect(lsFilesPathHex(pair.peer)).toEqual([D_FF_HEX, Z_HEX]);
        });
      });

      describe('When rm --cached --recursive names the directory d', () => {
        it('Then the lossy d/\\xff entry leaves the index', async () => {
          // Arrange
          seedLossyTwins();

          // Act
          await repo.rm(['d'], { cached: true, recursive: true });

          // Assert
          expect(lsFilesPathHex(pair.peer)).toEqual([Z_HEX, U_HEX, L_HEX]);
        });
      });
    });

    describe('Given a lossy entry and its UTF-8 twin tracked, with sparse-checkout narrowed then disabled', () => {
      describe('When sparse-checkout set then disable runs', () => {
        it('Then both lossy paths keep their bytes and the twin keeps its own content', async () => {
          // Arrange
          seedLossyTwins();

          // Act
          await repo.sparseCheckout.set({ patterns: ['z'], cone: false });
          await repo.sparseCheckout.disable();

          // Assert
          expect(lsFilesPathHex(pair.peer)).toEqual([D_FF_HEX, Z_HEX, U_HEX, L_HEX]);
          expect(readFileSync(path.join(pair.peer, U_FILE), 'utf8')).toBe('u\n');
        });
      });
    });

    describe('Given a lossy entry whose blob equals its twin file content', () => {
      describe('When status runs', () => {
        it('Then the lossy entry keeps its zero stat', async () => {
          // Arrange
          seedLossyTwins({ lossyBlob: 'u\n' });
          const ctx = createNodeContext({ workDir: pair.peer });

          // Act
          await repo.status();

          // Assert
          const lossy = (await readIndex(ctx)).entries.filter((e) => e.pathBytes !== undefined);
          expect(lossy.map((e) => hex(e.pathBytes as Uint8Array))).toEqual([D_FF_HEX, L_HEX]);
          expect(lossy.map((e) => [e.mtimeSeconds, e.ctimeSeconds])).toEqual([
            [0, 0],
            [0, 0],
          ]);
        });
      });
    });
  },
);

describe.skipIf(!GIT_AVAILABLE)(
  'index path bytes interop — HFS alias on raw bytes',
  { timeout: 60_000 },
  () => {
    const HFS_REASON = "'.git' HFS+ ignorable-codepoint alias rejected";
    let pair: PeerPair;
    let repo: Repository;

    const updateIndex = (protectHfs: boolean, rawPath: Uint8Array) => {
      const oid = hashBlob(pair.peer, 'x\n');
      const record = Buffer.concat([
        Buffer.from(`${REGULAR_MODE} ${oid}\t`),
        rawPath,
        Buffer.of(NUL),
      ]);
      return spawnSync(
        'git',
        [
          '-C',
          pair.peer,
          '-c',
          `core.protectHFS=${protectHfs}`,
          'update-index',
          '-z',
          '--add',
          '--index-info',
        ],
        { input: record, env: runGitEnv() },
      );
    };

    const readIndexError = async (): Promise<unknown> => {
      try {
        await readIndex(createNodeContext({ workDir: pair.peer }));
      } catch (error) {
        return (error as { data?: unknown }).data;
      }
      return undefined;
    };

    beforeEach(async () => {
      pair = await makePeerPair('index-path-bytes');
      runGit(['init', '-q', '-b', 'main', pair.peer]);
      repo = await openRepository({ cwd: pair.peer });
    });

    afterEach(async () => {
      await repo.dispose();
      await pair.dispose();
    });

    describe.each([
      ['.git\\xff/x', Uint8Array.of(0x2e, 0x67, 0x69, 0x74, 0xff, 0x2f, 0x78)],
      ['.git\\xc0\\xaf', Uint8Array.of(0x2e, 0x67, 0x69, 0x74, 0xc0, 0xaf)],
      [
        '.git\\xef\\xbf\\xbe/x',
        Uint8Array.of(0x2e, 0x67, 0x69, 0x74, 0xef, 0xbf, 0xbe, 0x2f, 0x78),
      ],
    ])('Given git staged %s with core.protectHFS=false', (_title, rawPath) => {
      describe('When the index is read', () => {
        it('Then tsgit refuses with the HFS reason and git protectHFS=true ignores the path', async () => {
          // Arrange
          updateIndex(false, rawPath);
          const guarded = updateIndex(true, rawPath);

          // Act
          const data = await readIndexError();

          // Assert
          expect(data).toMatchObject({ code: 'INVALID_INDEX_ENTRY', reason: HFS_REASON });
          expect(guarded.stderr.toString()).toContain('Ignoring path');
        });
      });
    });

    describe('Given git staged .git followed by U+FFFD', () => {
      describe('When the index is read', () => {
        it('Then both git and tsgit accept it', async () => {
          // Arrange
          const rawPath = Uint8Array.of(0x2e, 0x67, 0x69, 0x74, 0xef, 0xbf, 0xbd, 0x2f, 0x78);
          const guarded = updateIndex(true, rawPath);

          // Act
          const data = await readIndexError();

          // Assert
          expect(guarded.stderr.toString()).not.toContain('Ignoring path');
          expect(data).toBeUndefined();
        });
      });
    });
  },
);

describe.skipIf(!GIT_AVAILABLE)(
  'index path bytes interop — mv with lossy members',
  { timeout: 60_000 },
  () => {
    const U_DIR = '�';
    const D_FF_HEX = '642fff';
    const E_Y_HEX = '652f79';
    const FF_X_HEX = 'ff2f78';
    const DST_X_HEX = '6473742f78';
    const U_TXT = '�.txt';
    const FF_TXT_HEX = 'ff2e747874';
    let pair: PeerPair;
    let repo: Repository;

    const git = (...args: ReadonlyArray<string>): string =>
      runGit(['-C', pair.peer, ...args], { env: COMMIT_ENV });

    const stageLossy = (rawPath: Uint8Array): void =>
      stageRaw(pair.peer, [{ mode: REGULAR_MODE, oid: hashBlob(pair.peer, 'l\n'), path: rawPath }]);

    const rejectionOf = async (run: () => Promise<unknown>): Promise<unknown> => {
      try {
        await run();
      } catch (error) {
        return (error as { data?: unknown }).data;
      }
      return undefined;
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

    describe('Given d/y on disk and a lossy d/<0xff> staged', () => {
      beforeEach(() => {
        mkdirSync(path.join(pair.peer, 'd'));
        writeFileSync(path.join(pair.peer, 'd', 'y'), 'y\n');
        git('add', 'd/y');
        stageLossy(D_SLASH_FF);
      });

      describe('When mv d e runs', () => {
        it('Then it refuses naming the member and the index bytes are unchanged', async () => {
          // Arrange
          const before = lsFilesPathHex(pair.peer);

          // Act
          const data = await rejectionOf(() => repo.mv(['d'], 'e'));

          // Assert
          expect(data).toMatchObject({
            code: 'MV_BAD_SOURCE',
            source: 'd/�',
            destination: 'e/�',
          });
          expect(lsFilesPathHex(pair.peer)).toEqual(before);
        });
      });

      describe('When mv -k d e runs', () => {
        it('Then the lossy entry stays and the rest moves', async () => {
          // Arrange
          const sut = repo;

          // Act
          await sut.mv(['d'], 'e', { skipErrors: true });

          // Assert
          expect(lsFilesPathHex(pair.peer)).toEqual([D_FF_HEX, E_Y_HEX]);
        });
      });
    });

    describe('Given only a lossy d/<0xff> staged under a directory on disk', () => {
      describe('When mv d e runs', () => {
        it('Then it refuses naming the member', async () => {
          // Arrange
          mkdirSync(path.join(pair.peer, 'd'));
          stageLossy(D_SLASH_FF);

          // Act
          const data = await rejectionOf(() => repo.mv(['d'], 'e'));

          // Assert
          expect(data).toMatchObject({
            code: 'MV_BAD_SOURCE',
            source: 'd/�',
            destination: 'e/�',
          });
          expect(lsFilesPathHex(pair.peer)).toEqual([D_FF_HEX]);
        });
      });
    });

    describe('Given a U+FFFD directory on disk and a lossy <0xff>/x staged', () => {
      describe('When mv moves the U+FFFD directory to dst', () => {
        it('Then only the literal member moves and the lossy entry keeps its bytes', async () => {
          // Arrange
          mkdirSync(path.join(pair.peer, U_DIR));
          writeFileSync(path.join(pair.peer, U_DIR, 'x'), 'x\n');
          git('add', '.');
          stageLossy(Uint8Array.of(0xff, 0x2f, 0x78));

          // Act
          await repo.mv([U_DIR], 'dst');

          // Assert
          expect(lsFilesPathHex(pair.peer)).toEqual([DST_X_HEX, FF_X_HEX]);
        });
      });
    });

    describe('Given a U+FFFD file on disk and a lossy <0xff>.txt staged', () => {
      describe('When mv moves the U+FFFD file', () => {
        it('Then only the literal entry moves and the lossy entry stays', async () => {
          // Arrange
          writeFileSync(path.join(pair.peer, U_TXT), 'u\n');
          git('add', '.');
          stageLossy(FF_TXT);

          // Act
          await repo.mv([U_TXT], 'y');

          // Assert
          expect(lsFilesPathHex(pair.peer)).toEqual(['79', FF_TXT_HEX]);
        });
      });
    });

    describe('Given a lossy <0xff>/zit/p staged next to a U+FFFD/k directory member', () => {
      describe('When mv moves the U+FFFD directory to .g', () => {
        it('Then no .git entry appears and tsgit and git still read the index', async () => {
          // Arrange
          mkdirSync(path.join(pair.peer, U_DIR));
          writeFileSync(path.join(pair.peer, U_DIR, 'k'), 'k\n');
          git('add', '.');
          stageLossy(Uint8Array.of(0xff, 0x2f, 0x7a, 0x69, 0x74, 0x2f, 0x70));

          // Act
          await repo.mv([U_DIR], '.g');

          // Assert
          expect(lsFilesPathHex(pair.peer)).toEqual(['2e672f6b', 'ff2f7a69742f70']);
          expect(() => git('ls-files')).not.toThrow();
        });
      });
    });
  },
);
