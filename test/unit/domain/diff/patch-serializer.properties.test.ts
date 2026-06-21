import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { diffLines } from '../../../../src/domain/diff/line-diff.js';
import type { PatchFile } from '../../../../src/domain/diff/patch-serializer.js';
import { renderPatch } from '../../../../src/domain/diff/patch-serializer.js';
import { MAX_SCORE } from '../../../../src/domain/diff/similarity.js';
import type { FilePath, ObjectId } from '../../../../src/domain/objects/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/index.js';

const OID_A = 'a'.repeat(40) as ObjectId;
const OID_B = 'b'.repeat(40) as ObjectId;
const utf8 = new TextEncoder();

function arbAsciiLine(): fc.Arbitrary<string> {
  return fc
    .array(fc.integer({ min: 0x20, max: 0x7e }), { minLength: 0, maxLength: 12 })
    .map((codes) => String.fromCharCode(...codes));
}

function arbTextStream(): fc.Arbitrary<string> {
  return fc
    .array(arbAsciiLine(), { minLength: 1, maxLength: 8 })
    .map((lines) => `${lines.join('\n')}\n`);
}

function modify(oldContent: string, newContent: string): PatchFile {
  return {
    change: {
      type: 'modify',
      path: 'foo.txt' as FilePath,
      oldId: OID_A,
      newId: OID_B,
      oldMode: FILE_MODE.REGULAR,
      newMode: FILE_MODE.REGULAR,
    },
    oldContent: utf8.encode(oldContent),
    newContent: utf8.encode(newContent),
  };
}

interface BodyCounts {
  readonly contextLines: number;
  readonly deleteLines: number;
  readonly insertLines: number;
}

interface ParsedHunk {
  readonly oldLen: number;
  readonly newLen: number;
  readonly body: BodyCounts;
}

function parseHunkHeader(line: string): { readonly oldLen: number; readonly newLen: number } {
  // @@ -A[,B] +C[,D] @@ — extract B (default 1) and D (default 1)
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (match === null) throw new Error(`bad hunk header: ${line}`);
  const oldLen = match[2] !== undefined ? Number.parseInt(match[2], 10) : 1;
  const newLen = match[4] !== undefined ? Number.parseInt(match[4], 10) : 1;
  return { oldLen, newLen };
}

function parsePatch(text: string): ReadonlyArray<ParsedHunk> {
  const lines = text.split('\n');
  const hunks: ParsedHunk[] = [];
  let current: { readonly oldLen: number; readonly newLen: number } | undefined;
  let counts: BodyCounts = { contextLines: 0, deleteLines: 0, insertLines: 0 };
  const flush = (): void => {
    if (current !== undefined) {
      hunks.push({ ...current, body: counts });
      counts = { contextLines: 0, deleteLines: 0, insertLines: 0 };
      current = undefined;
    }
  };
  for (const line of lines) {
    if (line.startsWith('@@ ')) {
      flush();
      current = parseHunkHeader(line);
      continue;
    }
    if (current === undefined) continue;
    if (line.startsWith(' ')) counts = { ...counts, contextLines: counts.contextLines + 1 };
    else if (line.startsWith('-')) counts = { ...counts, deleteLines: counts.deleteLines + 1 };
    else if (line.startsWith('+')) counts = { ...counts, insertLines: counts.insertLines + 1 };
  }
  flush();
  return hunks;
}

function arbPath(): fc.Arbitrary<string> {
  return fc
    .array(fc.integer({ min: 0x61, max: 0x7a }), { minLength: 1, maxLength: 6 })
    .map((codes) => String.fromCharCode(...codes));
}

function arbAddFile(): fc.Arbitrary<PatchFile> {
  return fc.tuple(arbPath(), arbTextStream()).map(([path, content]) => ({
    change: {
      type: 'add',
      newPath: path as FilePath,
      newId: OID_A,
      newMode: FILE_MODE.REGULAR,
    },
    newContent: utf8.encode(content),
  }));
}

function arbDeleteFile(): fc.Arbitrary<PatchFile> {
  return fc.tuple(arbPath(), arbTextStream()).map(([path, content]) => ({
    change: {
      type: 'delete',
      oldPath: path as FilePath,
      oldId: OID_A,
      oldMode: FILE_MODE.REGULAR,
    },
    oldContent: utf8.encode(content),
  }));
}

function arbRenameFile(): fc.Arbitrary<PatchFile> {
  return fc.tuple(arbPath(), arbPath()).map(([oldPath, newPath]) => ({
    change: {
      type: 'rename',
      oldPath: oldPath as FilePath,
      newPath: newPath as FilePath,
      oldId: OID_A,
      newId: OID_A,
      oldMode: FILE_MODE.REGULAR,
      newMode: FILE_MODE.REGULAR,
      similarity: { score: MAX_SCORE, maxScore: MAX_SCORE },
    },
  }));
}

function arbBinaryAddFile(): fc.Arbitrary<PatchFile> {
  return fc
    .tuple(arbPath(), fc.uint8Array({ minLength: 1, maxLength: 16 }))
    .map(([path, bytes]) => {
      // Force a NUL byte at the front so isBinary() triggers regardless of
      // what fast-check picks for the rest of the payload.
      const withNul = new Uint8Array(bytes.length + 1);
      withNul[0] = 0x00;
      withNul.set(bytes, 1);
      return {
        change: {
          type: 'add',
          newPath: path as FilePath,
          newId: OID_A,
          newMode: FILE_MODE.REGULAR,
        },
        newContent: withNul,
      };
    });
}

function arbBytesMaybeBinary(): fc.Arbitrary<Uint8Array> {
  return fc.oneof(
    arbTextStream().map((stream) => utf8.encode(stream)),
    fc.uint8Array({ minLength: 1, maxLength: 16 }).map((bytes) => {
      // Force a leading NUL so isBinary() triggers regardless of the payload.
      const withNul = new Uint8Array(bytes.length + 1);
      withNul[0] = 0x00;
      withNul.set(bytes, 1);
      return withNul;
    }),
  );
}

function arbTypeChangeFile(): fc.Arbitrary<PatchFile> {
  return fc
    .tuple(arbPath(), fc.boolean(), arbBytesMaybeBinary(), arbBytesMaybeBinary())
    .map(([path, fileToSymlink, oldBytes, newBytes]) => ({
      change: {
        type: 'type-change',
        path: path as FilePath,
        oldId: OID_A,
        newId: OID_B,
        oldMode: fileToSymlink ? FILE_MODE.REGULAR : FILE_MODE.SYMLINK,
        newMode: fileToSymlink ? FILE_MODE.SYMLINK : FILE_MODE.REGULAR,
      },
      oldContent: oldBytes,
      newContent: newBytes,
    }));
}

function arbAnyShape(): fc.Arbitrary<PatchFile> {
  return fc.oneof(
    arbAddFile(),
    arbDeleteFile(),
    arbRenameFile(),
    arbBinaryAddFile(),
    arbTypeChangeFile(),
  );
}

describe('patch-serializer (properties)', () => {
  describe('Given two arbitrary ASCII text streams', () => {
    describe('When renderPatch emits a modify block', () => {
      it('Then every hunk satisfies oldLen = context + delete and newLen = context + insert', () => {
        fc.assert(
          fc.property(arbTextStream(), arbTextStream(), (oldText, newText) => {
            // Arrange
            const sut = renderPatch;

            // Act
            const text = sut([modify(oldText, newText)]);
            const hunks = parsePatch(text);

            // Assert
            for (const hunk of hunks) {
              expect(hunk.oldLen).toBe(hunk.body.contextLines + hunk.body.deleteLines);
              expect(hunk.newLen).toBe(hunk.body.contextLines + hunk.body.insertLines);
            }
          }),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given any single DiffChange shape (add, delete, rename, binary add, or type-change)', () => {
    describe('When renderPatch is called', () => {
      it('Then the text always starts with `diff --git ` and ends with `\\n`', () => {
        fc.assert(
          fc.property(arbAnyShape(), (file) => {
            // Arrange — fast-check supplied file
            const input = [file];

            // Act
            const sut = renderPatch(input);

            // Assert — invariants every file-class shares.
            expect(sut.startsWith('diff --git ')).toBe(true);
            expect(sut.endsWith('\n')).toBe(true);
          }),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given a pure rename DiffChange', () => {
    describe('When renderPatch is called', () => {
      it('Then the body carries exactly the four expected header lines', () => {
        fc.assert(
          fc.property(arbRenameFile(), (file) => {
            // Arrange — fast-check supplied file
            const input = [file];

            // Act
            const sut = renderPatch(input);

            // Assert — rename grammar is fixed: similarity index 100% +
            // rename from + rename to. No --- / +++ / hunks.
            expect(sut).toContain('similarity index 100%');
            expect(sut).toContain('rename from ');
            expect(sut).toContain('rename to ');
            expect(sut).not.toContain('\n--- ');
            expect(sut).not.toContain('\n+++ ');
            expect(sut).not.toContain('@@ ');
          }),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given a binary add DiffChange', () => {
    describe('When renderPatch is called', () => {
      it('Then the body carries the Binary files /dev/null and b/X differ line', () => {
        fc.assert(
          fc.property(arbBinaryAddFile(), (file) => {
            // Arrange — fast-check supplied file
            const input = [file];

            // Act
            const sut = renderPatch(input);

            // Assert — no hunk markers ever escape into a binary block.
            expect(sut).toContain('Binary files /dev/null and b/');
            expect(sut).toContain(' differ');
            expect(sut).not.toContain('@@ ');
          }),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given a type-change DiffChange (file↔symlink, arbitrary content)', () => {
    describe('When renderPatch is called', () => {
      it('Then it emits a deletion block then an addition block, no hunk marker inside a binary block', () => {
        fc.assert(
          fc.property(arbTypeChangeFile(), (file) => {
            // Arrange — fast-check supplied a type-change with any text/binary mix
            const input = [file];

            // Act
            const sut = renderPatch(input);

            // Assert — git renders a type-change as a full deletion then a full
            // addition. Group lines into `diff --git ` blocks; content lines are
            // +/-/space-prefixed, so they never match a bare header/marker prefix.
            const blocks: string[][] = [];
            for (const line of sut.split('\n')) {
              if (line.startsWith('diff --git ')) blocks.push([]);
              blocks[blocks.length - 1]?.push(line);
            }
            expect(blocks).toHaveLength(2);
            expect(blocks[0]?.some((line) => line.startsWith('deleted file mode '))).toBe(true);
            expect(blocks[1]?.some((line) => line.startsWith('new file mode '))).toBe(true);
            for (const block of blocks) {
              if (block.some((line) => line.startsWith('Binary files '))) {
                expect(block.some((line) => line.startsWith('@@ '))).toBe(false);
              }
            }
          }),
          { numRuns: 100 },
        );
      });
    });
  });

  describe('Given two arbitrary ASCII text streams', () => {
    describe('When renderPatch emits a modify block', () => {
      it('Then totals across hunks match diffLines edit counts', () => {
        fc.assert(
          fc.property(arbTextStream(), arbTextStream(), (oldText, newText) => {
            // Arrange — ours = old, theirs = new (matches renderModifyBlock's mapping)
            const oldBytes = utf8.encode(oldText);
            const newBytes = utf8.encode(newText);
            const ld = diffLines(oldBytes, newBytes);
            let expectedDeletes = 0;
            let expectedInserts = 0;
            for (const hunk of ld.hunks) {
              if (hunk.kind === 'ours-only') expectedDeletes += hunk.oursEnd - hunk.oursStart;
              if (hunk.kind === 'theirs-only') expectedInserts += hunk.theirsEnd - hunk.theirsStart;
            }

            // Act
            const text = renderPatch([modify(oldText, newText)]);
            const hunks = parsePatch(text);
            const totalDeletes = hunks.reduce((sum, h) => sum + h.body.deleteLines, 0);
            const totalInserts = hunks.reduce((sum, h) => sum + h.body.insertLines, 0);

            // Assert
            expect(totalDeletes).toBe(expectedDeletes);
            expect(totalInserts).toBe(expectedInserts);
          }),
          { numRuns: 100 },
        );
      });
    });
  });
});
