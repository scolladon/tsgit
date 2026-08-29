import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { TsgitError } from '../../../../src/domain/error.js';
import {
  parseReflog,
  parseReflogBytes,
  parseReflogLenientBytes,
  parseReflogLine,
  serializeReflogLine,
  serializeReflogRewriteLine,
  serializeReflogRewriteLineBytes,
} from '../../../../src/domain/reflog/reflog-format.js';
import {
  arbCandidateLine,
  arbEntry,
  arbNonZeroTimestamp,
  arbReflogLineBytes,
} from './arbitraries.js';

const TEXT_ENCODER = new TextEncoder();

describe('Given arbitrary bytes of any value', () => {
  describe('When parseReflogLenientBytes parses them', () => {
    it('Then it never throws', () => {
      // Arrange + Act + Assert — the full 0x00-0xFF alphabet, strictly wider
      // than the string tier's ASCII-no-NUL subset: the byte tier is the
      // reader every user-facing surface goes through.
      fc.assert(
        fc.property(fc.uint8Array({ maxLength: 400 }), (bytes) => {
          expect(() => parseReflogLenientBytes(bytes, 40)).not.toThrow();
        }),
        { numRuns: 100 },
      );
    });
  });
});

describe('Given an array of candidate reflog lines', () => {
  describe('When parseReflogLenientBytes parses the joined, LF-terminated file', () => {
    it('Then the entry count equals the number of individually-parseable lines', () => {
      // Arrange + Act + Assert — the oracle calls the per-line function; it
      // does not re-implement the lenient loop. Candidate lines are ASCII,
      // so their UTF-8 encoding is the identity projection byte-for-byte.
      const acceptsAsLine = (line: string): boolean => {
        try {
          parseReflogLine(line, 40);
          return true;
        } catch {
          return false;
        }
      };
      fc.assert(
        fc.property(fc.array(arbCandidateLine(), { maxLength: 20 }), (lines) => {
          const bytes = TEXT_ENCODER.encode(`${lines.join('\n')}\n`);

          expect(parseReflogLenientBytes(bytes, 40).length).toBe(
            lines.filter(acceptsAsLine).length,
          );
        }),
        { numRuns: 100 },
      );
    });
  });
});

describe('Given an arbitrary entry whose timestamp may be zero', () => {
  describe('When serializing then parsing with the strict parser', () => {
    it('Then the writer refuses only a zero timestamp, and every other entry round-trips exactly', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbEntry(), (entry) => {
          let line: string;
          try {
            line = serializeReflogLine(entry, 40);
          } catch (err) {
            expect((err as TsgitError).data).toEqual({
              code: 'INVALID_REFLOG_ENTRY',
              reason: 'timestamp must be non-zero',
            });
            expect(entry.identity.timestamp).toBe(0);
            return;
          }

          expect(parseReflog(line, 40)).toEqual([entry]);
        }),
        { numRuns: 200 },
      );
    });
  });
});

describe('Given an arbitrary entry with a non-zero timestamp', () => {
  describe('When serializing with the rewrite serializer then parsing with the strict parser', () => {
    it('Then every entry round-trips exactly', () => {
      // Arrange + Act + Assert — the rewrite serializer always emits the TAB,
      // so (unlike the append form) it never needs the zero-timestamp escape
      // hatch to stay total over this arbitrary.
      fc.assert(
        fc.property(arbEntry(arbNonZeroTimestamp()), (entry) => {
          const line = serializeReflogRewriteLine(entry, 40);

          expect(parseReflog(line, 40)).toEqual([entry]);
        }),
        { numRuns: 200 },
      );
    });
  });
});

describe('Given an arbitrary well-formed multi-line reflog file built directly in bytes', () => {
  describe('When parsing then re-serializing with the byte-tier functions', () => {
    it.each([40, 64] as const)(
      'Then the original file round-trips byte-exactly at hexLength %i',
      (hexLength) => {
        // Arrange + Act + Assert — the lens a UTF-8 string round trip cannot
        // cover: identity/message bytes span the full 0x20-0xFF range,
        // including values that are not valid UTF-8 on their own. Multi-line
        // files stress the per-line byte-offset arithmetic that single-line
        // inputs never touch.
        fc.assert(
          fc.property(
            fc.array(arbReflogLineBytes(hexLength), { minLength: 1, maxLength: 8 }),
            (lines) => {
              let total = 0;
              for (const line of lines) total += line.length;
              const file = new Uint8Array(total);
              let offset = 0;
              for (const line of lines) {
                file.set(line, offset);
                offset += line.length;
              }

              const entries = parseReflogBytes(file, hexLength);

              expect(entries).toHaveLength(lines.length);
              const rewritten = entries.map((entry) =>
                serializeReflogRewriteLineBytes(entry, hexLength),
              );
              const roundTripped = new Uint8Array(total);
              let out = 0;
              for (const line of rewritten) {
                roundTripped.set(line, out);
                out += line.length;
              }
              expect(roundTripped).toEqual(file);
            },
          ),
          { numRuns: 200 },
        );
      },
    );
  });
});

describe('Given a reflog file larger than one latin1 projection chunk', () => {
  describe('When parsing then re-serializing with the byte-tier functions', () => {
    it('Then the file round-trips byte-exactly across the chunk boundary', () => {
      // Arrange — 100 lines with a latin1 0xE9 byte per message push the
      // file well past the 8 KiB chunk the projection decodes at a time.
      const encoder = new TextEncoder();
      const parts: Uint8Array[] = [];
      for (let i = 0; i < 100; i += 1) {
        const padded = String(i).padStart(2, '0');
        parts.push(
          encoder.encode(
            `${'a'.repeat(38)}${padded} ${'b'.repeat(38)}${padded} Ada <ada@example.com> 17162400${padded} +0000\tmsg`,
          ),
        );
        parts.push(Uint8Array.of(0xe9, 0x0a));
      }
      let total = 0;
      for (const part of parts) total += part.length;
      const file = new Uint8Array(total);
      let offset = 0;
      for (const part of parts) {
        file.set(part, offset);
        offset += part.length;
      }
      expect(file.length).toBeGreaterThan(8192);

      // Act
      const entries = parseReflogBytes(file, 40);
      const rewritten = entries.map((entry) => serializeReflogRewriteLineBytes(entry, 40));

      // Assert
      expect(entries).toHaveLength(100);
      let out = 0;
      const roundTripped = new Uint8Array(total);
      for (const line of rewritten) {
        roundTripped.set(line, out);
        out += line.length;
      }
      expect(roundTripped).toEqual(file);
    });
  });
});
