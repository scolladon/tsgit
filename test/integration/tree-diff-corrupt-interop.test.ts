/**
 * Cross-tool interop — corrupt and edge-case trees, pinned against real git.
 *
 * The raw byte-cursor recursive diff enforces only git's structural
 * `decode_tree_entry` refusals (Pin A) and nothing else, so on-disk-order
 * trees that only `git fsck --strict` would flag are diffed rather than
 * refused (Pin B). Mode bytes are matched, not decoded (Pin C), and the
 * virtual trailing-slash directory sort order is exercised end to end
 * (Pin D). Every malformed/edge tree is hand-written past git's write-side
 * validity checks with `git hash-object -t tree -w --stdin --literally`,
 * then compared through `diffTrees(ctx, oldId, newId, { recursive: true })`
 * — the same primitive real commands call.
 *
 * Each test builds its `Context` fresh, after its own git-external writes:
 * tsgit's loose-object read path caches a fanout directory's membership per
 * `Context` on first probe and only self-invalidates when tsgit's own
 * `writeObject` adds to it. Objects here are written out-of-band by a real
 * `git` subprocess, so a `Context` shared across tests could serve a stale
 * membership set for a prefix it had already probed before a later test's
 * object landed under that same two-hex-digit directory.
 *
 * The library emits no display string — it returns structured data and lets
 * the caller render it — so every comparison reconstructs git's raw
 * `diff-tree -r` line (`:<oldMode> <newMode> <oldId> <newId> <status>\t<path>`)
 * from the structured `DiffChange` fields inside the test, rather than
 * asserting on rendered text. Refusal rows instead assert co-refusal:
 * tsgit's thrown error data plus git's real exit code.
 *
 * @proves
 *   surface:        diff.recursive
 *   bucket:         cross-tool-interop
 *   unique:         corrupt-tree diff refusals and fsck-class acceptances match canonical git
 *   interopSurface: diff
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { diffTrees } from '../../src/application/primitives/diff-trees.js';
import type { DiffChange } from '../../src/domain/diff/index.js';
import { encode, hexToBytes } from '../../src/domain/objects/encoding.js';
import { TsgitError } from '../../src/domain/objects/error.js';
import { EMPTY_TREE_OID, ObjectId } from '../../src/domain/objects/index.js';
import type { Context } from '../../src/ports/context.js';
import { GIT_AVAILABLE, runGit, tryRunGitWithExit } from './interop-helpers.js';

const SETUP_TIMEOUT = 60_000;
const ZERO_OID = '0'.repeat(40);

let dir = '';
let blobA = '';
let blobB = '';
let canonicalTree = '';

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

/** Hand-built `<mode> <name>\0<raw-oid>` bytes — the on-disk tree-entry
 * grammar built directly, so entry order/name shape/mode bytes are exactly
 * what a test declares rather than what `serializeTreeContent` would
 * canonicalise them to. */
function rawEntry(mode: string, name: string, oidHex: string): Uint8Array {
  return concatBytes(encode(`${mode} ${name}\0`), hexToBytes(oidHex));
}

/** Write hand-built tree bytes past git's write-side validity checks —
 * `--literally` is what lets the malformed/on-disk-order fixtures below
 * exist as real loose objects at all. */
function buildLiteralTree(body: Uint8Array): string {
  return runGit(['-C', dir, 'hash-object', '-t', 'tree', '-w', '--stdin', '--literally'], {
    input: body,
  }).trim();
}

/** A fresh `Context` over the shared repo, created after this test's git
 * writes — see the file header for why a shared, longer-lived `Context`
 * would risk a stale loose-object membership cache here. */
function freshCtx(): Context {
  return createNodeContext({ workDir: dir });
}

function toId(hex: string): ObjectId {
  return ObjectId.from(hex);
}

/** Reconstruct git's raw `diff-tree -r` line from one structured
 * `DiffChange` — the library emits no display string, so every comparison
 * to live git output is built from the structured fields inside the test. */
function rawLine(change: DiffChange): string {
  switch (change.type) {
    case 'add':
      return `:000000 ${change.newMode} ${ZERO_OID} ${change.newId} A\t${change.newPath}`;
    case 'delete':
      return `:${change.oldMode} 000000 ${change.oldId} ${ZERO_OID} D\t${change.oldPath}`;
    case 'modify':
      return `:${change.oldMode} ${change.newMode} ${change.oldId} ${change.newId} M\t${change.path}`;
    case 'type-change':
      return `:${change.oldMode} ${change.newMode} ${change.oldId} ${change.newId} T\t${change.path}`;
    case 'rename':
      return `:${change.oldMode} ${change.newMode} ${change.oldId} ${change.newId} R100\t${change.oldPath}\t${change.newPath}`;
    case 'copy':
      return `:${change.oldMode} ${change.newMode} ${change.oldId} ${change.newId} C100\t${change.oldPath}\t${change.newPath}`;
  }
}

function gitDiffTreeLines(oldTree: string, newTree: string): ReadonlyArray<string> {
  return tryRunGitWithExit([
    '-C',
    dir,
    'diff-tree',
    '-r',
    '--no-commit-id',
    '--abbrev=40',
    '--no-ext-diff',
    oldTree,
    newTree,
  ])
    .stdout.split('\n')
    .filter((line) => line.length > 0);
}

describe.skipIf(!GIT_AVAILABLE)('tree-diff corrupt interop', () => {
  beforeAll(async () => {
    dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-tree-diff-corrupt-')));
    runGit(['init', '-q', '-b', 'main', dir]);
    blobA = runGit(['-C', dir, 'hash-object', '-w', '--stdin'], { input: 'one\n' }).trim();
    blobB = runGit(['-C', dir, 'hash-object', '-w', '--stdin'], { input: 'two\n' }).trim();
    canonicalTree = buildLiteralTree(
      concatBytes(rawEntry('100644', 'a.txt', blobA), rawEntry('100644', 'b.txt', blobB)),
    );
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('Given Pin A structural refusals', () => {
    describe('When diffTrees recurses over a malformed tree', () => {
      const rows: ReadonlyArray<{
        readonly label: string;
        readonly body: (oidHex: string) => Uint8Array;
        readonly offset: number;
        readonly reason: string;
      }> = [
        {
          label: 'empty name',
          body: (oidHex) => rawEntry('100644', '', oidHex),
          offset: 0,
          reason: 'empty filename',
        },
        {
          label: 'truncated hash',
          body: (oidHex) =>
            concatBytes(encode('100644 a.txt\0'), hexToBytes(oidHex).subarray(0, 10)),
          offset: 0,
          reason: 'truncated hash',
        },
        {
          label: 'trailing junk after a complete entry',
          body: (oidHex) => concatBytes(rawEntry('100644', 'a.txt', oidHex), encode('xx')),
          offset: 33,
          reason: 'missing space after mode',
        },
        {
          label: 'no space after mode',
          body: (oidHex) => concatBytes(encode('100644a.txt\0'), hexToBytes(oidHex)),
          offset: 0,
          reason: 'missing space after mode',
        },
        {
          label: 'non-octal mode digit',
          body: (oidHex) => rawEntry('100648', 'a.txt', oidHex),
          offset: 0,
          reason: 'malformed mode',
        },
        {
          label: 'leading space (empty mode)',
          body: (oidHex) => concatBytes(encode(' 100644 a.txt\0'), hexToBytes(oidHex)),
          offset: 0,
          reason: 'malformed mode',
        },
      ];

      it.each(rows)(
        'Then $label is refused by both tsgit (INVALID_TREE_ENTRY) and git (exit 128)',
        async ({ body, offset, reason }) => {
          // Arrange
          const malformed = buildLiteralTree(body(blobA));
          const ctx = freshCtx();
          const sut = diffTrees;

          // Act
          const gitResult = tryRunGitWithExit([
            '-C',
            dir,
            'diff-tree',
            '-r',
            '--no-commit-id',
            '--no-ext-diff',
            EMPTY_TREE_OID,
            malformed,
          ]);
          let caught: unknown;
          try {
            await sut(ctx, EMPTY_TREE_OID, toId(malformed), { recursive: true });
          } catch (error) {
            caught = error;
          }

          // Assert
          expect(gitResult.exitCode).toBe(128);
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toEqual({
            code: 'INVALID_TREE_ENTRY',
            offset,
            reason,
          });
        },
      );
    });
  });

  describe('Given Pin B rows accepted by git diff-tree but flagged only by fsck --strict', () => {
    describe('When diffTrees recurses over an on-disk-order tree', () => {
      it('Then an unsorted new tree emits delete a.txt then add a.txt with the same oid on both sides (git-verified)', async () => {
        // Arrange
        const unsorted = buildLiteralTree(
          concatBytes(rawEntry('100644', 'b.txt', blobB), rawEntry('100644', 'a.txt', blobA)),
        );
        const peerLines = gitDiffTreeLines(canonicalTree, unsorted);
        const ctx = freshCtx();
        const sut = diffTrees;

        // Act
        const result = await sut(ctx, toId(canonicalTree), toId(unsorted), { recursive: true });

        // Assert
        expect(result.changes.map(rawLine)).toEqual(peerLines);
      });

      it('Then a duplicate-name new tree emits per-entry results with no refusal (git-verified)', async () => {
        // Arrange
        const duplicate = buildLiteralTree(
          concatBytes(rawEntry('100644', 'a.txt', blobA), rawEntry('100644', 'a.txt', blobB)),
        );
        const peerLines = gitDiffTreeLines(canonicalTree, duplicate);
        const ctx = freshCtx();
        const sut = diffTrees;

        // Act
        const result = await sut(ctx, toId(canonicalTree), toId(duplicate), { recursive: true });

        // Assert
        expect(result.changes.map(rawLine)).toEqual(peerLines);
      });

      it("Then a name containing a literal '/' is diffed, not refused (git-verified)", async () => {
        // Arrange
        const slashName = buildLiteralTree(rawEntry('100644', 'a/b', blobA));
        const peerLines = gitDiffTreeLines(EMPTY_TREE_OID, slashName);
        const ctx = freshCtx();
        const sut = diffTrees;

        // Act
        const result = await sut(ctx, EMPTY_TREE_OID, toId(slashName), { recursive: true });

        // Assert
        expect(result.changes.map(rawLine)).toEqual(peerLines);
      });

      it("Then a name of '.' is diffed, not refused (git-verified)", async () => {
        // Arrange
        const dotName = buildLiteralTree(rawEntry('100644', '.', blobA));
        const peerLines = gitDiffTreeLines(EMPTY_TREE_OID, dotName);
        const ctx = freshCtx();
        const sut = diffTrees;

        // Act
        const result = await sut(ctx, EMPTY_TREE_OID, toId(dotName), { recursive: true });

        // Assert
        expect(result.changes.map(rawLine)).toEqual(peerLines);
      });

      it("Then a name of '..' is diffed, not refused (git-verified)", async () => {
        // Arrange
        const dotDotName = buildLiteralTree(rawEntry('100644', '..', blobA));
        const peerLines = gitDiffTreeLines(EMPTY_TREE_OID, dotDotName);
        const ctx = freshCtx();
        const sut = diffTrees;

        // Act
        const result = await sut(ctx, EMPTY_TREE_OID, toId(dotDotName), { recursive: true });

        // Assert
        expect(result.changes.map(rawLine)).toEqual(peerLines);
      });
    });

    describe('When a non-recursive diff-tree pairs the same on-disk-order tree', () => {
      it("Then git reports byte-identical output with or without -r, while tsgit's parsed (non-recursive) path re-sorts and reports no change (a known, out-of-scope asymmetry)", async () => {
        // Arrange
        const unsorted = buildLiteralTree(
          concatBytes(rawEntry('100644', 'b.txt', blobB), rawEntry('100644', 'a.txt', blobA)),
        );
        const recursiveOutput = tryRunGitWithExit([
          '-C',
          dir,
          'diff-tree',
          '-r',
          '--no-commit-id',
          '--no-ext-diff',
          canonicalTree,
          unsorted,
        ]).stdout;
        const nonRecursiveOutput = tryRunGitWithExit([
          '-C',
          dir,
          'diff-tree',
          '--no-commit-id',
          '--no-ext-diff',
          canonicalTree,
          unsorted,
        ]).stdout;
        const ctx = freshCtx();
        const sut = diffTrees;

        // Act — the parsed (non-recursive) path's `entriesOf` re-sorts both
        // sides before classifying, so it never observes the on-disk order
        // the raw walk above pins; that is a pre-existing, out-of-scope
        // asymmetry between the two diff paths, not something this change
        // introduces or fixes.
        const result = await sut(ctx, toId(canonicalTree), toId(unsorted), { recursive: false });

        // Assert
        expect(nonRecursiveOutput).toBe(recursiveOutput);
        expect(result.changes).toEqual([]);
      });
    });
  });

  describe('Given Pin C mode-canonicalisation rows', () => {
    describe('When both sides canonicalise to the same mode and oid', () => {
      const rows: ReadonlyArray<{
        readonly label: string;
        readonly entry: (mode: string) => Uint8Array;
        readonly oldMode: string;
        readonly newMode: string;
      }> = [
        {
          label: '40000 vs 040000 (leading-zero directory form)',
          entry: (mode) => rawEntry(mode, 'd', canonicalTree),
          oldMode: '40000',
          newMode: '040000',
        },
        {
          label: '100644 vs 0100644 (leading-zero regular form)',
          entry: (mode) => rawEntry(mode, 'a.txt', blobA),
          oldMode: '100644',
          newMode: '0100644',
        },
      ];

      it.each(rows)(
        'Then $label produces no change on either side',
        async ({ entry, oldMode, newMode }) => {
          // Arrange
          const oldTree = buildLiteralTree(entry(oldMode));
          const newTree = buildLiteralTree(entry(newMode));
          const gitResult = tryRunGitWithExit([
            '-C',
            dir,
            'diff-tree',
            '-r',
            '--no-commit-id',
            '--no-ext-diff',
            oldTree,
            newTree,
          ]);
          const ctx = freshCtx();
          const sut = diffTrees;

          // Act
          const result = await sut(ctx, toId(oldTree), toId(newTree), { recursive: true });

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(gitResult.stdout.trim()).toBe('');
          expect(result.changes).toEqual([]);
        },
      );
    });

    describe("When one side is a mode git accepts but tsgit's five-value mode set does not", () => {
      const rows: ReadonlyArray<{
        readonly label: string;
        readonly entry: (mode: string) => Uint8Array;
        readonly oldMode: string;
        readonly newMode: string;
        readonly refusedValue: string;
        readonly expectedGitLine?: () => string;
      }> = [
        {
          label: '40000 vs 40644 (non-canonical directory form)',
          entry: (mode) => rawEntry(mode, 'd', canonicalTree),
          oldMode: '40000',
          newMode: '40644',
          refusedValue: '40644',
        },
        {
          label: '100644 vs 100664 (non-canonical regular form)',
          entry: (mode) => rawEntry(mode, 'a.txt', blobA),
          oldMode: '100644',
          newMode: '100664',
          refusedValue: '100664',
        },
        {
          label: '100644 vs 100777 (git canonicalises to 100755 and reports a modify)',
          entry: (mode) => rawEntry(mode, 'a.txt', blobA),
          oldMode: '100644',
          newMode: '100777',
          refusedValue: '100777',
          expectedGitLine: () => `:100644 100755 ${blobA} ${blobA} M\ta.txt`,
        },
      ];

      it.each(rows)(
        'Then $label: git accepts it silently but tsgit throws INVALID_FILE_MODE',
        async ({ entry, oldMode, newMode, refusedValue, expectedGitLine }) => {
          // Arrange — tsgit's normalizeFileMode only accepts the five FILE_MODE
          // values plus the 040000 leading-zero alias; git instead masks the
          // mode bits and canonicalises everything else, so these forms are a
          // documented, pre-existing divergence rather than a new refusal
          // this change introduces.
          const oldTree = buildLiteralTree(entry(oldMode));
          const newTree = buildLiteralTree(entry(newMode));
          const gitResult = tryRunGitWithExit([
            '-C',
            dir,
            'diff-tree',
            '-r',
            '--no-commit-id',
            '--no-ext-diff',
            oldTree,
            newTree,
          ]);
          const ctx = freshCtx();
          const sut = diffTrees;

          // Act
          let caught: unknown;
          try {
            await sut(ctx, toId(oldTree), toId(newTree), { recursive: true });
          } catch (error) {
            caught = error;
          }

          // Assert
          expect(gitResult.exitCode).toBe(0);
          expect(gitResult.stdout.trim()).toBe(
            expectedGitLine === undefined ? '' : expectedGitLine(),
          );
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data).toEqual({
            code: 'INVALID_FILE_MODE',
            value: refusedValue,
          });
        },
      );
    });
  });

  describe('Given the Pin D virtual trailing-slash sort order', () => {
    describe('When a recursive diff runs against a tree git itself wrote (write-tree over d/f, d.txt, d-dash, d0)', () => {
      it('Then adds are emitted in git order: d-dash, d.txt, d/f, d0', async () => {
        // Arrange
        await mkdir(path.join(dir, 'd'), { recursive: true });
        await writeFile(path.join(dir, 'd', 'f'), 'f content\n');
        await writeFile(path.join(dir, 'd.txt'), 'd.txt content\n');
        await writeFile(path.join(dir, 'd-dash'), 'd-dash content\n');
        await writeFile(path.join(dir, 'd0'), 'd0 content\n');
        runGit(['-C', dir, 'add', '-A']);
        const pinDTree = runGit(['-C', dir, 'write-tree']).trim();
        const peerLines = gitDiffTreeLines(EMPTY_TREE_OID, pinDTree);
        const ctx = freshCtx();
        const sut = diffTrees;

        // Act
        const result = await sut(ctx, EMPTY_TREE_OID, toId(pinDTree), { recursive: true });

        // Assert
        expect(result.changes.map(rawLine)).toEqual(peerLines);
      });
    });
  });
});
