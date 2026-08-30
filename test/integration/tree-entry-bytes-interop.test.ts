/**
 * Cross-tool interop — the whole tree entry-name byte and mode-tier parity
 * matrix, pinned in one interop suite: exotic entry-name bytes (a
 * byte-order mark, invalid UTF-8, `.`/`..`/an embedded separator, a
 * duplicated name) and malformed mode bytes, matched against canonical git
 * across every tsgit read surface — parse (`readTree`, `flattenTree`,
 * `revParse`), descent, materialisation (`buildIndexFromTree`) and `fsck`.
 *
 * Every fixture is hand-built as raw `<mode> SP <name-bytes> NUL <raw-oid>`
 * tree-entry bytes, never a source-code string literal for an exotic name —
 * `rawEntryBytes` takes the name as a `Uint8Array`. Fixtures git's own
 * write-side fsck refuses are written with `hash-object --literally`; the
 * ones git accepts are written WITHOUT it, so the acceptance itself is a
 * measured assertion. The library emits no display string: every
 * comparison reconstructs git's raw output (`<mode> <type> <oid>\t<name>`
 * for `ls-tree`, `error in tree <oid>: <msgId>: <text>` for `fsck`) from
 * tsgit's structured fields inside the test.
 *
 * @proves
 *   surface:        tree
 *   bucket:         cross-tool-interop
 *   unique:         exotic entry-name bytes and mode tiers match canonical git across every tsgit read path
 *   interopSurface: tree
 */
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import type { FsckFinding } from '../../src/application/commands/fsck.js';
import { fsck } from '../../src/application/commands/fsck.js';
import { readFileAt } from '../../src/application/commands/read-file-at.js';
import { revParse } from '../../src/application/commands/rev-parse.js';
import { buildIndexFromTree } from '../../src/application/primitives/build-index-from-tree.js';
import { flattenTree } from '../../src/application/primitives/flatten-tree.js';
import { readTree } from '../../src/application/primitives/read-tree.js';
import type { GitIndex } from '../../src/domain/git-index/index.js';
import { NO_PARSER_OFFSET } from '../../src/domain/git-index/path-validator.js';
import { encode, hexToBytes } from '../../src/domain/objects/encoding.js';
import { TsgitError } from '../../src/domain/objects/error.js';
import { SHA1_CONFIG } from '../../src/domain/objects/hash-config.js';
import { FILE_MODE, type FilePath, ObjectId } from '../../src/domain/objects/index.js';
import { serializeTreeContent } from '../../src/domain/objects/tree.js';
import type { Context } from '../../src/ports/context.js';
import {
  GIT_AVAILABLE,
  runGit,
  runGitBytes,
  runGitEnv,
  tryRunGitWithExit,
} from './interop-helpers.js';

const SETUP_TIMEOUT = 60_000;
const BOM = Uint8Array.of(0xef, 0xbb, 0xbf);

// ---------------------------------------------------------------------------
// Helpers copied, deliberately, from tree-diff-corrupt-interop.test.ts (its
// L58-86) rather than shared, so that suite's declared `diff` surface stays
// what it says.
// ---------------------------------------------------------------------------

function concatBytes(...parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function rawEntry(mode: string, name: string, oidHex: string): Uint8Array {
  return concatBytes(encode(`${mode} ${name}\0`), hexToBytes(oidHex));
}

/** Raw-bytes counterpart of `rawEntry`, for names that must never live as a
 *  source-code string literal (an exotic byte, a BOM, invalid UTF-8). */
function rawEntryBytes(mode: string, nameBytes: Uint8Array, oidHex: string): Uint8Array {
  return concatBytes(encode(`${mode} `), nameBytes, Uint8Array.of(0), hexToBytes(oidHex));
}

function buildLiteralTreeIn(repoDir: string, body: Uint8Array): string {
  return runGit(['-C', repoDir, 'hash-object', '-t', 'tree', '-w', '--stdin', '--literally'], {
    input: body,
  }).trim();
}

/** Write structurally-valid tree bytes WITHOUT `--literally` — git's own
 *  write-side fsck runs, so a fixture that should be accepted validates
 *  itself against reality the moment this call does not throw. */
function buildTreeIn(repoDir: string, body: Uint8Array): string {
  return runGit(['-C', repoDir, 'hash-object', '-t', 'tree', '-w', '--stdin'], {
    input: body,
  }).trim();
}

function toId(hex: string): ObjectId {
  return ObjectId.from(hex);
}

// ---------------------------------------------------------------------------
// Other local helpers
// ---------------------------------------------------------------------------

/** Byte-cursor-free git-side reconstruction: `ls-tree -z` emits raw name
 *  bytes with no octal quoting, so this is the peer for a `nameBytes`
 *  comparison — never decode git's own output as text. */
interface LsTreeRecord {
  readonly mode: string;
  readonly type: string;
  readonly oid: string;
  readonly nameBytes: Uint8Array;
}

function parseLsTreeZ(raw: Uint8Array): ReadonlyArray<LsTreeRecord> {
  const records: LsTreeRecord[] = [];
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== 0x00) continue;
    records.push(parseLsTreeZRecord(raw.subarray(start, i)));
    start = i + 1;
  }
  return records;
}

function parseLsTreeZRecord(record: Uint8Array): LsTreeRecord {
  const tabIdx = record.indexOf(0x09);
  const header = new TextDecoder().decode(record.subarray(0, tabIdx));
  const [mode, type, oid] = header.split(' ');
  return {
    mode: mode ?? '',
    type: type ?? '',
    oid: oid ?? '',
    nameBytes: record.subarray(tabIdx + 1),
  };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function repeatBytes(pattern: Uint8Array, times: number): Uint8Array {
  const out = new Uint8Array(pattern.length * times);
  for (let i = 0; i < times; i++) out.set(pattern, i * pattern.length);
  return out;
}

async function captureThrow(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error;
  }
}

const EMPTY_INDEX: GitIndex = {
  version: 2,
  entries: [],
  extensions: [],
  trailerSha: new Uint8Array(0),
};

const BAD_TREE_TEXT = 'cannot be parsed as a tree';
const DUPLICATE_ENTRIES_TEXT = 'contains duplicate file entries';
const LARGE_PATHNAME_TEXT = 'contains excessively large pathname';
const TREE_NOT_SORTED_TEXT = 'not properly sorted';

const reconstructTreeLine = (severity: string, id: string, msgId: string, text: string): string =>
  `${severity} in tree ${id}: ${msgId}: ${text}`;

const isBadObjectFor = (
  finding: FsckFinding,
  id: string,
): finding is FsckFinding & { type: 'bad-object' } =>
  finding.type === 'bad-object' && finding.id === id;

// ---------------------------------------------------------------------------
// Shared base repo — read-layer, descent and materialisation cases. Each
// case builds a fresh Context after its own git-external writes: tsgit's
// loose-object read path caches a fanout directory's membership per Context
// and only self-invalidates on tsgit's own writeObject, so a Context reused
// across cases could serve a stale membership set for a prefix a later
// case's object lands under.
// ---------------------------------------------------------------------------

let dir = '';
let blobA = ''; // 'one\n'
let blobB = ''; // 'two\n'
let idxScratchDir = '';

function freshCtx(): Context {
  return createNodeContext({ workDir: dir });
}

describe.skipIf(!GIT_AVAILABLE)('tree entry-name bytes interop', () => {
  beforeAll(async () => {
    dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-tree-bytes-')));
    runGit(['init', '-q', '-b', 'main', dir]);
    blobA = runGit(['-C', dir, 'hash-object', '-w', '--stdin'], { input: 'one\n' }).trim();
    blobB = runGit(['-C', dir, 'hash-object', '-w', '--stdin'], { input: 'two\n' }).trim();
    idxScratchDir = path.join(dir, '.idx-scratch');
    await mkdir(idxScratchDir, { recursive: true });
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------
  // Case 1 — parse-tier co-refusal, all three parse sites
  // ---------------------------------------------------------------------

  describe('Given a tree that fails at the parse tier (empty name, or a malformed mode)', () => {
    describe('When readTree, flattenTree and revParse all read it', () => {
      const rows: ReadonlyArray<{
        readonly label: string;
        readonly body: (oidHex: string) => Uint8Array;
        readonly offset: number;
        readonly reason: string;
        readonly gitMessage: string;
      }> = [
        {
          label: 'empty name',
          body: (oidHex) => rawEntry('100644', '', oidHex),
          offset: 0,
          reason: 'empty filename',
          gitMessage: 'fatal: empty filename in tree entry',
        },
        {
          label: 'non-octal mode digit',
          body: (oidHex) => rawEntry('10064a', 'a', oidHex),
          offset: 0,
          reason: 'malformed mode',
          gitMessage: 'fatal: malformed mode in tree entry',
        },
        {
          label: 'empty mode (leading space)',
          body: (oidHex) => concatBytes(encode(' 100644 a\0'), hexToBytes(oidHex)),
          offset: 0,
          reason: 'malformed mode',
          gitMessage: 'fatal: malformed mode in tree entry',
        },
      ];

      it.each(rows)(
        'Then $label is refused by git ls-tree (exit 128) and by readTree, flattenTree and revParse alike',
        async ({ body, offset, reason, gitMessage }) => {
          // Arrange
          const treeId = buildLiteralTreeIn(dir, body(blobA));
          const ctx = freshCtx();

          // Act
          const gitResult = tryRunGitWithExit(['-C', dir, 'ls-tree', treeId]);
          const readTreeError = await captureThrow(() => readTree(ctx, toId(treeId)));
          const flattenTreeError = await captureThrow(() => flattenTree(ctx, toId(treeId)));
          const revParseError = await captureThrow(() => revParse(ctx, `${treeId}:x`));

          // Assert
          expect(gitResult.exitCode).toBe(128);
          expect(gitResult.stderr).toContain(gitMessage);
          for (const error of [readTreeError, flattenTreeError, revParseError]) {
            expect(error).toBeInstanceOf(TsgitError);
            expect((error as TsgitError).data).toEqual({
              code: 'INVALID_TREE_ENTRY',
              offset,
              reason,
            });
          }
        },
      );
    });
  });

  // ---------------------------------------------------------------------
  // Cases 2 & 3 — byte-class acceptance + round-trip bytes
  // ---------------------------------------------------------------------

  describe('Given exotic but well-formed entry-name bytes (a BOM, invalid UTF-8)', () => {
    describe('When git ls-tree -z and tsgit readTree both read the tree', () => {
      const acceptanceRows: ReadonlyArray<{
        readonly label: string;
        readonly entries: ReadonlyArray<{
          readonly nameBytes: Uint8Array;
          readonly oidOf: () => string;
        }>;
      }> = [
        {
          label: 'BOM + "a"',
          entries: [{ nameBytes: concatBytes(BOM, encode('a')), oidOf: () => blobA }],
        },
        {
          label: 'bare BOM',
          entries: [{ nameBytes: BOM, oidOf: () => blobA }],
        },
        {
          label: 'two invalid-UTF-8 names (0xFE, 0xFF)',
          entries: [
            { nameBytes: Uint8Array.of(0xfe), oidOf: () => blobA },
            { nameBytes: Uint8Array.of(0xff), oidOf: () => blobB },
          ],
        },
        {
          label: 'BOM + "."',
          entries: [{ nameBytes: concatBytes(BOM, encode('.')), oidOf: () => blobA }],
        },
        {
          label: 'BOM + ".."',
          entries: [{ nameBytes: concatBytes(BOM, encode('..')), oidOf: () => blobA }],
        },
        {
          label: '"a" and BOM + "a"',
          entries: [
            { nameBytes: encode('a'), oidOf: () => blobA },
            { nameBytes: concatBytes(BOM, encode('a')), oidOf: () => blobB },
          ],
        },
      ];

      it.each(acceptanceRows)(
        'Then git and tsgit both accept $label, agree on the entry set, and a re-serialize round-trips byte for byte',
        async ({ entries }) => {
          // Arrange
          const body = concatBytes(
            ...entries.map((e) => rawEntryBytes(FILE_MODE.REGULAR, e.nameBytes, e.oidOf())),
          );
          const treeId = buildTreeIn(dir, body);
          const ctx = freshCtx();
          const gitRecords = parseLsTreeZ(runGitBytes(['-C', dir, 'ls-tree', '-z', treeId]));
          const sut = readTree;

          // Act
          const tree = await sut(ctx, toId(treeId));

          // Assert — entry set agrees, byte for byte
          expect(tree.entries).toHaveLength(entries.length);
          expect(gitRecords).toHaveLength(entries.length);
          for (const record of gitRecords) {
            const match = tree.entries.find((e) => bytesEqual(e.nameBytes, record.nameBytes));
            expect(match).toBeDefined();
            expect(match?.mode).toBe(record.mode);
            expect(match?.id).toBe(record.oid);
          }

          // Assert — round-trip: re-serializing what tsgit parsed reproduces
          // the exact on-disk body git accepted (the only direct oracle for
          // byte-identity between parse and serialize).
          const serialized = serializeTreeContent(tree, SHA1_CONFIG);
          expect(Array.from(serialized)).toEqual(Array.from(body));
        },
      );
    });

    describe('When a mode of 40000 points at a blob rather than a tree', () => {
      it('Then git accepts the write structurally, and readTree parses one entry without verifying the target type', async () => {
        // Arrange — row 8: a type mismatch is deliberately not asserted
        // further (recursion/ls-tree -r behaviour is out of scope here).
        const body = rawEntry('40000', 'd', blobA);
        const treeId = buildTreeIn(dir, body);
        const ctx = freshCtx();
        const sut = readTree;

        // Act
        const tree = await sut(ctx, toId(treeId));

        // Assert
        expect(tree.entries).toHaveLength(1);
        expect(tree.entries[0]?.mode).toBe(FILE_MODE.DIRECTORY);
        expect(tree.entries[0]?.id).toBe(blobA);
      });
    });
  });

  // ---------------------------------------------------------------------
  // Case 4 & 10 — name-shape parity: read layer accepts, materialisation
  // layer refuses "."/".." (including the nested `sub/.` full-path form)
  // and accepts an embedded separator, whose descent (case 10) resolves.
  // ---------------------------------------------------------------------

  describe('Given entry names shaped like "." / ".." / an embedded separator', () => {
    describe('When the read layer parses and descends them', () => {
      const shapeRows: ReadonlyArray<{ readonly label: string; readonly name: string }> = [
        { label: '"."', name: '.' },
        { label: '".."', name: '..' },
        { label: '"a/b" (embedded separator)', name: 'a/b' },
      ];

      it.each(shapeRows)(
        'Then git ls-tree lists $label (exit 0), and tsgit readTree/flattenTree accept it too',
        async ({ name }) => {
          // Arrange
          const treeId = buildLiteralTreeIn(dir, rawEntry('100644', name, blobA));
          const ctx = freshCtx();
          const gitResult = tryRunGitWithExit(['-C', dir, 'ls-tree', treeId]);

          // Act
          const tree = await readTree(ctx, toId(treeId));
          const flat = await flattenTree(ctx, toId(treeId));

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(tree.entries).toHaveLength(1);
          expect(tree.entries[0]?.name).toBe(name);
          expect(flat.entries.get(name as FilePath)?.id).toBe(blobA);
        },
      );

      it('Then git rev-parse <tree>:. and <tree>:.. resolve to the blob, and tsgit revParse resolves them too (parity)', async () => {
        // Arrange
        const dotTree = buildLiteralTreeIn(dir, rawEntry('100644', '.', blobA));
        const dotdotTree = buildLiteralTreeIn(dir, rawEntry('100644', '..', blobA));
        const ctx = freshCtx();

        // Act
        const gitDot = tryRunGitWithExit(['-C', dir, 'rev-parse', `${dotTree}:.`]);
        const gitDotdot = tryRunGitWithExit(['-C', dir, 'rev-parse', `${dotdotTree}:..`]);
        const tsgitDot = await revParse(ctx, `${dotTree}:.`);
        const tsgitDotdot = await revParse(ctx, `${dotdotTree}:..`);

        // Assert
        expect(gitDot.exitCode).toBe(0);
        expect(gitDot.stdout.trim()).toBe(blobA);
        expect(tsgitDot).toBe(blobA);
        expect(gitDotdot.exitCode).toBe(0);
        expect(gitDotdot.stdout.trim()).toBe(blobA);
        expect(tsgitDotdot).toBe(blobA);
      });

      it('Then git rev-parse <tree>:a/b resolves against an entry literally named "a/b", and tsgit revParse descends it too', async () => {
        // Arrange — the embedded-separator resolution proves the separator
        // refusal is gone rather than merely relocated.
        const slashTree = buildLiteralTreeIn(dir, rawEntry('100644', 'a/b', blobA));
        const ctx = freshCtx();

        // Act
        const gitResult = tryRunGitWithExit(['-C', dir, 'rev-parse', `${slashTree}:a/b`]);
        const tsgitResult = await revParse(ctx, `${slashTree}:a/b`);

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(gitResult.stdout.trim()).toBe(blobA);
        expect(tsgitResult).toBe(blobA);
      });

      it('Then git rev-parse <tree>:a/b/c resolves through a separator-bearing TREE name, and tsgit revParse descends it too', async () => {
        // Arrange — root's sole entry is a TREE literally named "a/b",
        // holding "c": the segment 'a' misses and the whole path 'a/b/c'
        // misses too, so only the intermediate prefix boundary 'a/b' —
        // itself a tree — lets the descent continue with the unconsumed
        // tail 'c'.
        const innerTree = buildTreeIn(dir, rawEntry('100644', 'c', blobA));
        const slashDirTree = buildLiteralTreeIn(dir, rawEntry('40000', 'a/b', innerTree));
        const ctx = freshCtx();

        // Act
        const gitResult = tryRunGitWithExit(['-C', dir, 'rev-parse', `${slashDirTree}:a/b/c`]);
        const tsgitResult = await revParse(ctx, `${slashDirTree}:a/b/c`);

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(gitResult.stdout.trim()).toBe(blobA);
        expect(tsgitResult).toBe(blobA);
      });

      it('Then git rev-parse <tree>:a/b/c refuses when "a/b" is a BLOB, and tsgit revParse refuses too (parity)', async () => {
        // Arrange — root's sole entry is literally named "a/b" but is a
        // regular file: the boundary 'a/b' matches by name but is not a
        // tree, so it cannot be descended into, and no entry is literally
        // named 'a/b/c' either — a prefix boundary only ever completes a
        // descent through a tree.
        const slashBlobTree = buildLiteralTreeIn(dir, rawEntry('100644', 'a/b', blobA));
        const ctx = freshCtx();

        // Act
        const gitResult = tryRunGitWithExit(['-C', dir, 'rev-parse', `${slashBlobTree}:a/b/c`]);
        const tsgitError = await captureThrow(() => revParse(ctx, `${slashBlobTree}:a/b/c`));

        // Assert
        expect(gitResult.exitCode).not.toBe(0);
        expect(tsgitError).toBeInstanceOf(TsgitError);
        expect((tsgitError as TsgitError).data).toEqual({
          code: 'PATH_NOT_IN_TREE',
          rev: slashBlobTree,
          path: 'a/b/c',
        });
      });
    });

    describe('When the materialisation layer (buildIndexFromTree) indexes them', () => {
      function readTreeIntoTempIndex(
        treeId: string,
        indexName: string,
      ): { readonly exitCode: number; readonly stderr: string; readonly indexPath: string } {
        const indexPath = path.join(idxScratchDir, indexName);
        const result = tryRunGitWithExit([
          '-C',
          dir,
          'read-tree',
          `--index-output=${indexPath}`,
          treeId,
        ]);
        return { exitCode: result.exitCode, stderr: result.stderr, indexPath };
      }

      function lsFilesStage(indexPath: string): string {
        return runGit(['-C', dir, 'ls-files', '-s'], {
          env: { ...runGitEnv(), GIT_INDEX_FILE: indexPath },
        });
      }

      const refusalRows: ReadonlyArray<{
        readonly label: string;
        readonly buildTreeId: () => string;
        readonly reason: string;
        readonly gitPath: string;
      }> = [
        {
          label: 'name "."',
          buildTreeId: () => buildLiteralTreeIn(dir, rawEntry('100644', '.', blobA)),
          reason: "'.' segment rejected",
          gitPath: '.',
        },
        {
          label: 'name ".."',
          buildTreeId: () => buildLiteralTreeIn(dir, rawEntry('100644', '..', blobA)),
          reason: "'..' segment rejected",
          gitPath: '..',
        },
        {
          label: 'nested tree whose sole entry is named "." (full path sub/.)',
          buildTreeId: () => {
            const inner = buildLiteralTreeIn(dir, rawEntry('100644', '.', blobA));
            return buildLiteralTreeIn(dir, rawEntry('40000', 'sub', inner));
          },
          reason: "'.' segment rejected",
          gitPath: 'sub/.',
        },
      ];

      it.each(refusalRows)(
        'Then git read-tree refuses $label (exit 128, invalid path), and tsgit buildIndexFromTree throws INVALID_INDEX_ENTRY',
        async ({ buildTreeId, reason, gitPath }, index) => {
          // Arrange
          const treeId = buildTreeId();
          const ctx = freshCtx();

          // Act
          const gitResult = readTreeIntoTempIndex(treeId, `refuse-${index}`);
          const error = await captureThrow(() =>
            buildIndexFromTree(ctx, { targetTree: toId(treeId), currentIndex: EMPTY_INDEX }),
          );

          // Assert
          expect(gitResult.exitCode).toBe(128);
          expect(gitResult.stderr).toContain(`error: invalid path '${gitPath}'`);
          expect(error).toBeInstanceOf(TsgitError);
          expect((error as TsgitError).data).toEqual({
            code: 'INVALID_INDEX_ENTRY',
            offset: NO_PARSER_OFFSET,
            reason,
          });
        },
      );

      it('Then git read-tree accepts an embedded separator (exit 0, index entry a/b), and tsgit buildIndexFromTree indexes it at "a/b" without refusing', async () => {
        // Arrange
        const slashTree = buildLiteralTreeIn(dir, rawEntry('100644', 'a/b', blobA));
        const ctx = freshCtx();

        // Act
        const gitResult = readTreeIntoTempIndex(slashTree, 'accept-ab');
        const staged = lsFilesStage(gitResult.indexPath);
        const entries = await buildIndexFromTree(ctx, {
          targetTree: toId(slashTree),
          currentIndex: EMPTY_INDEX,
        });

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(staged).toContain('a/b');
        expect(entries).toHaveLength(1);
        expect(entries[0]?.path).toBe('a/b');
        expect(entries[0]?.id).toBe(blobA);
      });
    });
  });

  // ---------------------------------------------------------------------
  // Case 5 — duplicate behaviour, per surface
  // ---------------------------------------------------------------------

  describe('Given a tree with a duplicated entry name', () => {
    describe('When each read surface resolves the duplicate independently', () => {
      it('Then git ls-tree lists both, and readTree returns two entries (a key-collapse killer)', async () => {
        // Arrange
        const dupTree = buildLiteralTreeIn(
          dir,
          concatBytes(rawEntry('100644', 'a', blobA), rawEntry('100644', 'a', blobB)),
        );
        const ctx = freshCtx();
        const gitResult = tryRunGitWithExit(['-C', dir, 'ls-tree', dupTree]);
        const sut = readTree;

        // Act
        const tree = await sut(ctx, toId(dupTree));

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(tree.entries).toHaveLength(2);
      });

      it('Then git rev-parse <tree>:a resolves the FIRST entry, and tsgit revParse / readFileAt agree', async () => {
        // Arrange
        const dupTree = buildLiteralTreeIn(
          dir,
          concatBytes(rawEntry('100644', 'a', blobA), rawEntry('100644', 'a', blobB)),
        );
        const ctx = freshCtx();
        const gitResult = tryRunGitWithExit(['-C', dir, 'rev-parse', `${dupTree}:a`]);

        // Act
        const revParsed = await revParse(ctx, `${dupTree}:a`);
        const read = await readFileAt(freshCtx(), dupTree, 'a');

        // Assert
        expect(gitResult.exitCode).toBe(0);
        expect(gitResult.stdout.trim()).toBe(blobA);
        expect(revParsed).toBe(blobA);
        expect(read.id).toBe(blobA);
      });

      it('Then git read-tree + ls-files -s keeps the LAST entry, and tsgit flattenTree keeps the last too', async () => {
        // Arrange
        const dupTree = buildLiteralTreeIn(
          dir,
          concatBytes(rawEntry('100644', 'a', blobA), rawEntry('100644', 'a', blobB)),
        );
        const indexPath = path.join(idxScratchDir, 'dup-last-wins');
        const readTreeResult = tryRunGitWithExit([
          '-C',
          dir,
          'read-tree',
          `--index-output=${indexPath}`,
          dupTree,
        ]);
        const staged = runGit(['-C', dir, 'ls-files', '-s'], {
          env: { ...runGitEnv(), GIT_INDEX_FILE: indexPath },
        });
        const ctx = freshCtx();
        const sut = flattenTree;

        // Act
        const flat = await sut(ctx, toId(dupTree));

        // Assert
        expect(readTreeResult.exitCode).toBe(0);
        expect(staged.trim()).toBe(`100644 ${blobB} 0\ta`);
        expect(flat.entries.get('a' as FilePath)?.id).toBe(blobB);
      });
    });
  });

  // ---------------------------------------------------------------------
  // Case 8 — the FlatTree collapse: git's index keeps two entries for
  // invalid-UTF-8 siblings, tsgit's FlatTree collapses them to one key.
  // ---------------------------------------------------------------------

  describe('Given two invalid-UTF-8 sibling names that decode to the same replacement character', () => {
    describe("When git's index and tsgit's FlatTree both materialise the tree", () => {
      it('Then git read-tree + ls-files -s keeps two index entries, while flattenTree carries one FlatTree key (never a worktree comparison)', async () => {
        // Arrange — row 4 through flattenTree. Never compared via a real
        // worktree checkout: checkout-index itself fails on these names on
        // APFS with "Illegal byte sequence", a filesystem-level fact, not a
        // tsgit/git divergence.
        const treeId = buildTreeIn(
          dir,
          concatBytes(
            rawEntryBytes(FILE_MODE.REGULAR, Uint8Array.of(0xfe), blobA),
            rawEntryBytes(FILE_MODE.REGULAR, Uint8Array.of(0xff), blobB),
          ),
        );
        const indexPath = path.join(idxScratchDir, 'filepath-collapse');
        const readTreeResult = tryRunGitWithExit([
          '-C',
          dir,
          'read-tree',
          `--index-output=${indexPath}`,
          treeId,
        ]);
        const staged = runGit(['-C', dir, 'ls-files', '-s'], {
          env: { ...runGitEnv(), GIT_INDEX_FILE: indexPath },
        });
        const ctx = freshCtx();
        const sut = flattenTree;

        // Act
        const flat = await sut(ctx, toId(treeId));

        // Assert
        expect(readTreeResult.exitCode).toBe(0);
        expect(staged.trim().split('\n')).toHaveLength(2);
        expect(flat.entries.size).toBe(1);
      });
    });
  });

  // ---------------------------------------------------------------------
  // Case 6, 7 & 9 — fsck parity, isolated repos so exit-code assertions
  // stay exact (an unrelated finding in a shared store would inflate them).
  // ---------------------------------------------------------------------

  describe('fsck-only faults', () => {
    describe('Given a repo with every ERROR-tier fault (badTree, duplicateEntries, treeNotSorted), When both tools fsck it', () => {
      let errorTierDir = '';
      let errorTierBlob = '';
      let emptyNameTreeId = '';
      let malformedModeTreeId = '';
      let emptyModeTreeId = '';
      let checkOrderTreeId = '';
      let dupSameModeTreeId = '';
      let dupDiffModeTreeId = '';
      let sortedBomTreeId = '';
      let reversedBomTreeId = '';
      let sortedFeFfTreeId = '';
      let reversedFeFfTreeId = '';

      beforeAll(async () => {
        errorTierDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-tree-bytes-fsck-error-'));
        runGit(['init', '-q', '-b', 'main', errorTierDir]);
        errorTierBlob = runGit(['-C', errorTierDir, 'hash-object', '-w', '--stdin'], {
          input: 'one\n',
        }).trim();
        const bB = runGit(['-C', errorTierDir, 'hash-object', '-w', '--stdin'], {
          input: 'two\n',
        }).trim();

        emptyNameTreeId = buildLiteralTreeIn(errorTierDir, rawEntry('100644', '', errorTierBlob));
        malformedModeTreeId = buildLiteralTreeIn(
          errorTierDir,
          rawEntry('10064a', 'a', errorTierBlob),
        );
        emptyModeTreeId = buildLiteralTreeIn(
          errorTierDir,
          concatBytes(encode(' 100644 a\0'), hexToBytes(errorTierBlob)),
        );
        checkOrderTreeId = buildLiteralTreeIn(errorTierDir, rawEntry('10064a', '.', errorTierBlob));
        dupSameModeTreeId = buildLiteralTreeIn(
          errorTierDir,
          concatBytes(rawEntry('100644', 'a', errorTierBlob), rawEntry('100644', 'a', bB)),
        );
        dupDiffModeTreeId = buildLiteralTreeIn(
          errorTierDir,
          concatBytes(rawEntry('100644', 'a', errorTierBlob), rawEntry('40000', 'a', bB)),
        );
        sortedBomTreeId = buildTreeIn(
          errorTierDir,
          concatBytes(
            rawEntry('100644', 'a', errorTierBlob),
            rawEntryBytes(FILE_MODE.REGULAR, concatBytes(BOM, encode('a')), bB),
          ),
        );
        reversedBomTreeId = buildLiteralTreeIn(
          errorTierDir,
          concatBytes(
            rawEntryBytes(FILE_MODE.REGULAR, concatBytes(BOM, encode('a')), bB),
            rawEntry('100644', 'a', errorTierBlob),
          ),
        );
        sortedFeFfTreeId = buildTreeIn(
          errorTierDir,
          concatBytes(
            rawEntryBytes(FILE_MODE.REGULAR, Uint8Array.of(0xfe), errorTierBlob),
            rawEntryBytes(FILE_MODE.REGULAR, Uint8Array.of(0xff), bB),
          ),
        );
        reversedFeFfTreeId = buildLiteralTreeIn(
          errorTierDir,
          concatBytes(
            rawEntryBytes(FILE_MODE.REGULAR, Uint8Array.of(0xff), bB),
            rawEntryBytes(FILE_MODE.REGULAR, Uint8Array.of(0xfe), errorTierBlob),
          ),
        );
      }, SETUP_TIMEOUT);

      afterAll(async () => {
        await rm(errorTierDir, { recursive: true, force: true });
      });

      const strictRows: ReadonlyArray<{ readonly label: string; readonly strict: boolean }> = [
        { label: 'without --strict', strict: false },
        { label: 'with --strict', strict: true },
      ];

      it.each(strictRows)(
        'Then git fsck and tsgit fsck both exit 1 $label (every finding here is ERROR-class, unaffected by --strict)',
        async ({ strict }) => {
          // Arrange
          const gitFlags = strict ? ['--strict'] : [];
          const gitResult = tryRunGitWithExit(['-C', errorTierDir, 'fsck', ...gitFlags]);
          const ctx = createNodeContext({ workDir: errorTierDir });

          // Act
          const result = await fsck(ctx, { strict });

          // Assert
          expect(gitResult.exitCode).toBe(1);
          expect(result.exitCode).toBe(1);

          const rows: ReadonlyArray<{
            readonly id: string;
            readonly msgId: string;
            readonly text: string;
          }> = [
            { id: emptyNameTreeId, msgId: 'badTree', text: BAD_TREE_TEXT },
            { id: malformedModeTreeId, msgId: 'badTree', text: BAD_TREE_TEXT },
            { id: emptyModeTreeId, msgId: 'badTree', text: BAD_TREE_TEXT },
            { id: checkOrderTreeId, msgId: 'badTree', text: BAD_TREE_TEXT },
            { id: dupSameModeTreeId, msgId: 'duplicateEntries', text: DUPLICATE_ENTRIES_TEXT },
            { id: dupDiffModeTreeId, msgId: 'duplicateEntries', text: DUPLICATE_ENTRIES_TEXT },
            { id: reversedBomTreeId, msgId: 'treeNotSorted', text: TREE_NOT_SORTED_TEXT },
            { id: reversedFeFfTreeId, msgId: 'treeNotSorted', text: TREE_NOT_SORTED_TEXT },
          ];
          for (const row of rows) {
            const findingsForId = result.findings.filter((f) => isBadObjectFor(f, row.id));
            expect(findingsForId).toHaveLength(1);
            expect(findingsForId[0]?.msgId).toBe(row.msgId);
            expect(findingsForId[0]?.severity).toBe('error');
            expect(findingsForId[0]?.objectType).toBe('tree');
            expect(gitResult.stderr).toContain(
              reconstructTreeLine('error', row.id, row.msgId, row.text),
            );
          }

          // Assert — the accepted, correctly-sorted trees carry no
          // content-validation finding (a dangling/unreachable connectivity
          // classification is expected for every unreferenced loose object
          // here and is not itself a fault).
          for (const acceptedId of [sortedBomTreeId, sortedFeFfTreeId]) {
            expect(result.findings.filter((f) => isBadObjectFor(f, acceptedId))).toEqual([]);
          }
        },
      );
    });

    describe('Given a repo with only a badFilemode fault (mode 777777), When both tools fsck it', () => {
      let badFilemodeDir = '';
      let badFilemodeTreeId = '';

      beforeAll(async () => {
        badFilemodeDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-tree-bytes-fsck-mode-'));
        runGit(['init', '-q', '-b', 'main', badFilemodeDir]);
        const blob = runGit(['-C', badFilemodeDir, 'hash-object', '-w', '--stdin'], {
          input: 'one\n',
        }).trim();
        badFilemodeTreeId = buildLiteralTreeIn(badFilemodeDir, rawEntry('777777', 'a', blob));
      }, SETUP_TIMEOUT);

      afterAll(async () => {
        await rm(badFilemodeDir, { recursive: true, force: true });
      });

      const strictRows: ReadonlyArray<{ readonly label: string; readonly strict: boolean }> = [
        { label: 'without --strict', strict: false },
        { label: 'with --strict', strict: true },
      ];

      it.each(strictRows)(
        'Then badFilemode stays exit 0 $label on both sides (INFO-class, never upgraded)',
        async ({ strict }) => {
          // Arrange — git's own severity LABEL for this msg-id differs
          // ("warning" vs tsgit's "info"); the behaviour agrees and the
          // label is deliberately not asserted here.
          const gitFlags = strict ? ['--strict'] : [];
          const gitResult = tryRunGitWithExit(['-C', badFilemodeDir, 'fsck', ...gitFlags]);
          const ctx = createNodeContext({ workDir: badFilemodeDir });

          // Act
          const result = await fsck(ctx, { strict });

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(result.exitCode).toBe(0);
          const finding = result.findings.find((f) => isBadObjectFor(f, badFilemodeTreeId));
          expect(finding?.msgId).toBe('badFilemode');
          expect(finding?.severity).toBe('info');
          expect(gitResult.stderr).toContain(
            `in tree ${badFilemodeTreeId}: badFilemode: contains bad file modes`,
          );
        },
      );
    });

    describe('Given a repo with the largePathname boundary (raw-byte and multi-byte-UTF-8 encodings), When both tools fsck it', () => {
      let largePathnameDir = '';
      let blob = '';
      let acceptedRawTreeId = '';
      let refusedRawTreeId = '';
      let acceptedMultibyteTreeId = '';
      let refusedMultibyteTreeId = '';

      beforeAll(async () => {
        largePathnameDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-tree-bytes-fsck-large-'));
        runGit(['init', '-q', '-b', 'main', largePathnameDir]);
        blob = runGit(['-C', largePathnameDir, 'hash-object', '-w', '--stdin'], {
          input: 'one\n',
        }).trim();

        acceptedRawTreeId = buildTreeIn(
          largePathnameDir,
          rawEntryBytes(FILE_MODE.REGULAR, encode('x'.repeat(4096)), blob),
        );
        refusedRawTreeId = buildLiteralTreeIn(
          largePathnameDir,
          rawEntryBytes(FILE_MODE.REGULAR, encode('x'.repeat(4097)), blob),
        );
        // 2048 x (C3 A9) = 4096 raw bytes, exactly at the boundary — the
        // count is raw bytes, never code points.
        acceptedMultibyteTreeId = buildTreeIn(
          largePathnameDir,
          rawEntryBytes(FILE_MODE.REGULAR, repeatBytes(Uint8Array.of(0xc3, 0xa9), 2048), blob),
        );
        // 1366 x (E2 82 AC) = 4098 raw bytes, one code-point group past it.
        refusedMultibyteTreeId = buildLiteralTreeIn(
          largePathnameDir,
          rawEntryBytes(
            FILE_MODE.REGULAR,
            repeatBytes(Uint8Array.of(0xe2, 0x82, 0xac), 1366),
            blob,
          ),
        );
      }, SETUP_TIMEOUT);

      afterAll(async () => {
        await rm(largePathnameDir, { recursive: true, force: true });
      });

      const strictRows: ReadonlyArray<{
        readonly label: string;
        readonly strict: boolean;
        readonly exitCode: number;
        readonly severity: 'warning' | 'error';
      }> = [
        {
          label: 'without --strict (WARN, exit 0)',
          strict: false,
          exitCode: 0,
          severity: 'warning',
        },
        { label: 'with --strict (ERROR, exit 1)', strict: true, exitCode: 1, severity: 'error' },
      ];

      it.each(strictRows)(
        'Then 4096/4096-multibyte raw bytes stay accepted and 4097/4098-multibyte are largePathname $label',
        async ({ strict, exitCode, severity }) => {
          // Arrange
          const gitFlags = strict ? ['--strict'] : [];
          const gitResult = tryRunGitWithExit(['-C', largePathnameDir, 'fsck', ...gitFlags]);
          const ctx = createNodeContext({ workDir: largePathnameDir });

          // Act
          const result = await fsck(ctx, { strict });

          // Assert
          expect(gitResult.exitCode).toBe(exitCode);
          expect(result.exitCode).toBe(exitCode);
          for (const acceptedId of [acceptedRawTreeId, acceptedMultibyteTreeId]) {
            expect(result.findings.filter((f) => isBadObjectFor(f, acceptedId))).toEqual([]);
          }
          for (const refusedId of [refusedRawTreeId, refusedMultibyteTreeId]) {
            const finding = result.findings.find((f) => isBadObjectFor(f, refusedId));
            expect(finding?.msgId).toBe('largePathname');
            expect(finding?.severity).toBe(severity);
            expect(gitResult.stderr).toContain(
              reconstructTreeLine(severity, refusedId, 'largePathname', LARGE_PATHNAME_TEXT),
            );
          }
        },
      );
    });

    describe('Given a repo with a single, clean, BOM-named tree, When both fsck passes run', () => {
      let bomAgreementDir = '';
      let bomTreeId = '';

      beforeAll(async () => {
        bomAgreementDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-tree-bytes-fsck-bom-'));
        runGit(['init', '-q', '-b', 'main', bomAgreementDir]);
        const blob = runGit(['-C', bomAgreementDir, 'hash-object', '-w', '--stdin'], {
          input: 'one\n',
        }).trim();
        bomTreeId = buildTreeIn(bomAgreementDir, rawEntryBytes(FILE_MODE.REGULAR, BOM, blob));
      }, SETUP_TIMEOUT);

      afterAll(async () => {
        await rm(bomAgreementDir, { recursive: true, force: true });
      });

      it('Then git fsck reports nothing for the BOM tree (exit 0), and neither tsgit pass treats it as unreadable', async () => {
        // Arrange
        const gitResult = tryRunGitWithExit(['-C', bomAgreementDir, 'fsck']);
        const ctx = createNodeContext({ workDir: bomAgreementDir });

        // Act
        const result = await fsck(ctx);

        // Assert — git's content-tier verdict
        expect(gitResult.exitCode).toBe(0);
        expect(gitResult.stderr).not.toContain(bomTreeId);

        // Assert — tsgit's content-validation pass raised no finding
        expect(result.exitCode).toBe(0);
        expect(result.findings.filter((f) => isBadObjectFor(f, bomTreeId))).toEqual([]);

        // Assert — tsgit's object-cache pass decoded it as a real tree
        // (never `null`/unreadable, which would surface as objectType
        // 'unknown' on the dangling classification below).
        const dangling = result.findings.find(
          (f): f is FsckFinding & { type: 'dangling' } =>
            f.type === 'dangling' && f.id === bomTreeId,
        );
        expect(dangling?.objectType).toBe('tree');
      });
    });

    // -------------------------------------------------------------------
    // Case 12 — the dotgit alias fold: git's is_hfs_dotgit/is_ntfs_dotgit
    // rule folds a case variant, an NTFS 8.3 short name and an HFS-ignorable
    // code point at a mid-position onto '.git', and does NOT fold either
    // negative control. The .gitattributes family folds the same way
    // (re-measured against git 2.55.0, resolving the round-2 open question:
    // a case-folded ".GITATTRIBUTES" symlink still reports
    // gitattributesSymlink, at the INFO severity that is never upgraded
    // under --strict).
    // -------------------------------------------------------------------

    describe('Given the dotgit alias matrix (case-fold, NTFS short name, HFS mid-position, two negative controls), When both tools fsck it', () => {
      let aliasDir = '';
      let caseFoldTreeId = '';
      let ntfsShortNameTreeId = '';
      let hfsMidTreeId = '';
      let negativeDotDotGitTreeId = '';
      let negativeShortNameTreeId = '';
      let gitattributesCaseFoldTreeId = '';

      beforeAll(async () => {
        aliasDir = await mkdtemp(path.join(os.tmpdir(), 'tsgit-tree-bytes-fsck-alias-'));
        runGit(['init', '-q', '-b', 'main', aliasDir]);
        const blob = runGit(['-C', aliasDir, 'hash-object', '-w', '--stdin'], {
          input: 'one\n',
        }).trim();

        caseFoldTreeId = buildLiteralTreeIn(aliasDir, rawEntry('100644', '.GIT', blob));
        ntfsShortNameTreeId = buildLiteralTreeIn(aliasDir, rawEntry('100644', 'git~1', blob));
        hfsMidTreeId = buildLiteralTreeIn(
          aliasDir,
          rawEntryBytes(
            FILE_MODE.REGULAR,
            concatBytes(encode('.g'), Uint8Array.of(0xe2, 0x80, 0x8c), encode('it')),
            blob,
          ),
        );
        negativeDotDotGitTreeId = buildTreeIn(aliasDir, rawEntry('100644', '..git', blob));
        negativeShortNameTreeId = buildTreeIn(aliasDir, rawEntry('100644', 'gi~1', blob));
        gitattributesCaseFoldTreeId = buildLiteralTreeIn(
          aliasDir,
          rawEntryBytes(FILE_MODE.SYMLINK, encode('.GITATTRIBUTES'), blob),
        );
      }, SETUP_TIMEOUT);

      afterAll(async () => {
        await rm(aliasDir, { recursive: true, force: true });
      });

      const strictRows: ReadonlyArray<{ readonly label: string; readonly strict: boolean }> = [
        { label: 'without --strict', strict: false },
        { label: 'with --strict', strict: true },
      ];

      it.each(strictRows)(
        'Then git and tsgit fsck agree on every aliased and non-aliased row $label',
        async ({ strict }) => {
          // Arrange — one whole-directory fsck call: passing a specific oid
          // to `git fsck` does not scope the scan to that object, it still
          // walks every loose object, so the repo-wide exit code and
          // stderr are what both tools are compared against.
          const gitFlags = strict ? ['--strict'] : [];
          const gitResult = tryRunGitWithExit(['-C', aliasDir, 'fsck', ...gitFlags]);
          const ctx = createNodeContext({ workDir: aliasDir });

          // Act
          const result = await fsck(ctx, { strict });

          // Assert — every hasDotgit alias upgrades the exit code together
          // under --strict (WARN → ERROR); gitattributesSymlink is INFO and
          // never does, so the repo's worst finding without --strict is
          // still just a warning.
          expect(gitResult.exitCode).toBe(strict ? 1 : 0);
          expect(result.exitCode).toBe(strict ? 1 : 0);

          // Assert — case-fold, NTFS short name and HFS mid-position all
          // alias '.git', at hasDotgit's own severity (WARN, upgraded to
          // ERROR only under --strict).
          const expectedSeverity = strict ? 'error' : 'warning';
          for (const id of [caseFoldTreeId, ntfsShortNameTreeId, hfsMidTreeId]) {
            const finding = result.findings.find((f) => isBadObjectFor(f, id));
            expect(finding?.msgId).toBe('hasDotgit');
            expect(finding?.severity).toBe(expectedSeverity);
            expect(gitResult.stderr).toContain(
              reconstructTreeLine(expectedSeverity, id, 'hasDotgit', "contains '.git'"),
            );
          }

          // Assert — the two negative controls never alias '.git' on either
          // side: an over-matching fold is worse than the gap it closes.
          for (const id of [negativeDotDotGitTreeId, negativeShortNameTreeId]) {
            expect(gitResult.stderr).not.toContain(`in tree ${id}: hasDotgit`);
            expect(result.findings.filter((f) => isBadObjectFor(f, id))).toEqual([]);
          }

          // Assert — the .gitattributes family folds case the same way.
          const gitattributesFinding = result.findings.find((f) =>
            isBadObjectFor(f, gitattributesCaseFoldTreeId),
          );
          expect(gitattributesFinding?.msgId).toBe('gitattributesSymlink');
          expect(gitattributesFinding?.severity).toBe('info');
          expect(gitResult.stderr).toContain(
            reconstructTreeLine(
              'warning',
              gitattributesCaseFoldTreeId,
              'gitattributesSymlink',
              '.gitattributes is a symlink',
            ),
          );
        },
      );
    });
  });

  // ---------------------------------------------------------------------
  // Case 11 — hash-width independence: at least one acceptance and one
  // parse-tier refusal row re-run under --object-format=sha256.
  // ---------------------------------------------------------------------

  describe('Given a --object-format=sha256 repository, When an exotic entry name round-trips', () => {
    let sha256Dir = '';

    beforeAll(async () => {
      sha256Dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-tree-bytes-sha256-')));
      runGit(['init', '-q', '-b', 'main', '--object-format=sha256', sha256Dir]);
    }, SETUP_TIMEOUT);

    afterAll(async () => {
      await rm(sha256Dir, { recursive: true, force: true });
    });

    it('Then a BOM-prefixed name is accepted by git and by tsgit readTree (row 2, SHA-256 width)', async () => {
      // Arrange
      const blob = runGit(['-C', sha256Dir, 'hash-object', '-w', '--stdin'], {
        input: 'one\n',
      }).trim();
      const body = rawEntryBytes(FILE_MODE.REGULAR, concatBytes(BOM, encode('a')), blob);
      const treeId = buildTreeIn(sha256Dir, body);
      const ctx = createNodeContext({ workDir: sha256Dir, algorithm: 'sha256' });
      const sut = readTree;

      // Act
      const tree = await sut(ctx, toId(treeId));

      // Assert
      expect(tree.entries).toHaveLength(1);
      expect(tree.entries[0]?.id).toBe(blob);
    });

    it('Then an empty entry name is refused by git ls-tree (exit 128) and by tsgit readTree (row 13, SHA-256 width)', async () => {
      // Arrange
      const blob = runGit(['-C', sha256Dir, 'hash-object', '-w', '--stdin'], {
        input: 'one\n',
      }).trim();
      const body = rawEntry('100644', '', blob);
      const treeId = buildLiteralTreeIn(sha256Dir, body);
      const gitResult = tryRunGitWithExit(['-C', sha256Dir, 'ls-tree', treeId]);
      const ctx = createNodeContext({ workDir: sha256Dir, algorithm: 'sha256' });

      // Act
      const error = await captureThrow(() => readTree(ctx, toId(treeId)));

      // Assert
      expect(gitResult.exitCode).toBe(128);
      expect(gitResult.stderr).toContain('fatal: empty filename in tree entry');
      expect(error).toBeInstanceOf(TsgitError);
      expect((error as TsgitError).data).toEqual({
        code: 'INVALID_TREE_ENTRY',
        offset: 0,
        reason: 'empty filename',
      });
    });
  });
});
