import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { diffLines } from '../../../../src/domain/diff/line-diff.js';
import type { PatchFile } from '../../../../src/domain/diff/patch-serializer.js';
import { renderPatch } from '../../../../src/domain/diff/patch-serializer.js';
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
