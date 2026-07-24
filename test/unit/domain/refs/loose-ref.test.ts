import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { TsgitError } from '../../../../src/domain/error.js';
import type { ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import {
  parseLooseRef,
  serializeDirectRef,
  serializeSymbolicRef,
} from '../../../../src/domain/refs/loose-ref.js';
import { arbObjectId } from '../objects/arbitraries.js';
import { arbRefName } from './arbitraries.js';

const SHA1 = 'a'.repeat(40) as ObjectId;
const SHA256 = 'b'.repeat(64) as ObjectId;

describe('parseLooseRef', () => {
  describe('Given loose-ref content encoding a direct ref', () => {
    describe('When parsing', () => {
      it.each([
        { content: `${SHA1}\n`, target: SHA1, label: 'returns DirectRef with correct ObjectId' },
        { content: `${SHA256}\n`, target: SHA256, label: 'returns DirectRef for a SHA-256 id' },
        { content: `${SHA1}\r\n`, target: SHA1, label: 'handles CRLF gracefully' },
        {
          content: SHA1 as string,
          target: SHA1,
          label: 'handles a missing trailing newline gracefully',
        },
      ])('Then $label', ({ content, target }) => {
        // Arrange & Act
        const sut = parseLooseRef(content);

        // Assert
        expect(sut).toEqual({ type: 'direct', target });
      });
    });
  });

  describe("Given 'ref: refs/heads/main\\\\n'", () => {
    describe('When parsing', () => {
      it("Then returns SymbolicRef with target 'refs/heads/main'", () => {
        // Arrange
        const content = 'ref: refs/heads/main\n';

        // Act
        const sut = parseLooseRef(content);

        // Assert
        expect(sut).toEqual({ type: 'symbolic', target: 'refs/heads/main' });
      });
    });
  });

  describe("Given 'ref: refs/heads/main' (no newline)", () => {
    describe('When parsing', () => {
      it('Then handles gracefully', () => {
        // Arrange
        const content = 'ref: refs/heads/main';

        // Act
        const sut = parseLooseRef(content);

        // Assert
        expect(sut).toEqual({ type: 'symbolic', target: 'refs/heads/main' });
      });
    });
  });

  describe('Given loose-ref content producing a specific INVALID_REF reason', () => {
    describe('When parsing', () => {
      it.each([
        { content: '', label: 'empty content', reason: 'empty ref content' },
        {
          content: 'ref: ',
          label: 'empty symbolic ref target',
          reason: 'empty symbolic ref target',
        },
        {
          content: 'ref: \n',
          label: 'whitespace-only target after trim',
          reason: 'empty symbolic ref target',
        },
      ])('Then $label throws INVALID_REF', ({ content, reason }) => {
        // Arrange & Act & Assert
        try {
          parseLooseRef(content);
          // Assert
          expect.fail('should have thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(TsgitError);
          expect((e as TsgitError).data.code).toBe('INVALID_REF');
          expect((e as TsgitError).data).toHaveProperty('reason', reason);
        }
      });
    });
  });

  describe("Given 'not-a-sha'", () => {
    describe('When parsing', () => {
      it('Then throws INVALID_OBJECT_ID', () => {
        // Arrange
        try {
          parseLooseRef('not-a-sha');
          // Assert
          expect.fail('should have thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(TsgitError);
          expect((e as TsgitError).data.code).toBe('INVALID_OBJECT_ID');
        }
      });
    });
  });

  describe("Given 'ref: ../../../etc/passwd\\\\n' (path traversal)", () => {
    describe('When parsing', () => {
      it('Then throws INVALID_REF', () => {
        // Arrange
        try {
          parseLooseRef('ref: ../../../etc/passwd\n');
          // Assert
          expect.fail('should have thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(TsgitError);
          expect((e as TsgitError).data.code).toBe('INVALID_REF');
        }
      });
    });
  });

  describe('Given content with embedded newline before trailing newline', () => {
    describe('When parsing', () => {
      it('Then only trailing newlines are stripped', () => {
        // Arrange — embedded \n should remain, causing ObjectId.from to fail
        const content = `${'a'.repeat(20)}\n${'b'.repeat(20)}\n`;

        // Act & Assert
        try {
          parseLooseRef(content);
          // Assert
          expect.fail('should have thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(TsgitError);
          expect((e as TsgitError).data.code).toBe('INVALID_OBJECT_ID');
        }
      });
    });
  });

  describe('Given a symbolic ref with an embedded newline and NO trailing newline', () => {
    describe('When parsing', () => {
      it('Then the embedded newline is preserved and rejected', () => {
        // Arrange — only the *trailing* CR/LF run must be stripped (the `$` anchor).
        // An embedded `\n` here keeps the target invalid; if the anchor were dropped
        // the first-found `\n` would be erased, joining the segments into a valid name.
        const content = 'ref: refs/heads/main\nrefs/heads/other';

        // Act & Assert
        try {
          parseLooseRef(content);
          // Assert
          expect.fail('should have thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(TsgitError);
          expect((e as TsgitError).data.code).toBe('INVALID_REF');
          expect((e as TsgitError).data).toHaveProperty(
            'reason',
            'ref name contains forbidden character',
          );
        }
      });
    });
  });
});

describe('serializeDirectRef', () => {
  describe('Given any ObjectId', () => {
    describe('When serializing', () => {
      it("Then result is '<sha>\\n'", () => {
        // Arrange & Act
        const sut = serializeDirectRef(SHA1);

        // Assert
        expect(sut).toBe(`${SHA1}\n`);
      });
    });
  });
});

describe('serializeSymbolicRef', () => {
  describe('Given any RefName', () => {
    describe('When serializing', () => {
      it("Then result is 'ref: <name>\\n'", () => {
        // Arrange
        const target = 'refs/heads/main' as RefName;

        // Act
        const sut = serializeSymbolicRef(target);

        // Assert
        expect(sut).toBe('ref: refs/heads/main\n');
      });
    });
  });
});

describe('roundtrip', () => {
  describe('Given any ObjectId', () => {
    describe('When serializing then parsing', () => {
      it('Then roundtrips', () => {
        // Arrange + Assert
        fc.assert(
          fc.property(arbObjectId(), (id) => {
            const sut = parseLooseRef(serializeDirectRef(id));
            expect(sut).toEqual({ type: 'direct', target: id });
          }),
        );
      });
    });
  });

  describe('Given any RefName (via arbRefName)', () => {
    describe('When serializing symbolic then parsing', () => {
      it('Then roundtrips', () => {
        // Arrange + Assert
        fc.assert(
          fc.property(arbRefName(), (name) => {
            const sut = parseLooseRef(serializeSymbolicRef(name));
            expect(sut).toEqual({ type: 'symbolic', target: name });
          }),
        );
      });
    });
  });
});
