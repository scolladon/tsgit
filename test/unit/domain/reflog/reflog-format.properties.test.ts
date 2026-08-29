import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { TsgitError } from '../../../../src/domain/error.js';
import {
  parseReflog,
  parseReflogLenient,
  parseReflogLine,
  serializeReflogLine,
  serializeReflogRewriteLine,
} from '../../../../src/domain/reflog/reflog-format.js';
import { arbCandidateLine, arbEntry, arbNonZeroTimestamp, arbReflogText } from './arbitraries.js';

describe('Given an arbitrary ASCII text with no NUL', () => {
  describe('When parseReflogLenient parses it', () => {
    it('Then it never throws', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbReflogText(), (text) => {
          expect(() => parseReflogLenient(text, 40)).not.toThrow();
        }),
        { numRuns: 100 },
      );
    });
  });
});

describe('Given an array of candidate reflog lines', () => {
  describe('When parseReflogLenient parses the joined, LF-terminated file', () => {
    it('Then the entry count equals the number of individually-parseable lines', () => {
      // Arrange + Act + Assert — the oracle calls the per-line function; it
      // does not re-implement parseReflogLenient's own loop.
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
          const text = `${lines.join('\n')}\n`;

          expect(parseReflogLenient(text, 40).length).toBe(lines.filter(acceptsAsLine).length);
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
