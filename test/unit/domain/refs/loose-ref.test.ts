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
  describe("Given '<40-char-sha>\\\\n'", () => {
    describe('When parsing', () => {
      it('Then returns DirectRef with correct ObjectId', () => {
        // Arrange
        const content = `${SHA1}\n`;

        // Act
        const sut = parseLooseRef(content);

        // Assert
        expect(sut).toEqual({ type: 'direct', target: SHA1 });
      });
    });
  });

  describe("Given '<64-char-sha>\\\\n' (SHA-256)", () => {
    describe('When parsing', () => {
      it('Then returns DirectRef', () => {
        // Arrange
        const content = `${SHA256}\n`;

        // Act
        const sut = parseLooseRef(content);

        // Assert
        expect(sut).toEqual({ type: 'direct', target: SHA256 });
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

  describe("Given '<sha>\\\\r\\\\n'", () => {
    describe('When parsing', () => {
      it('Then handles CRLF gracefully', () => {
        // Arrange
        const content = `${SHA1}\r\n`;

        // Act
        const sut = parseLooseRef(content);

        // Assert
        expect(sut).toEqual({ type: 'direct', target: SHA1 });
      });
    });
  });

  describe("Given '<sha>' (no trailing newline)", () => {
    describe('When parsing', () => {
      it('Then handles gracefully', () => {
        // Arrange
        const content = SHA1 as string;

        // Act
        const sut = parseLooseRef(content);

        // Assert
        expect(sut).toEqual({ type: 'direct', target: SHA1 });
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

  describe("Given '' (empty)", () => {
    describe('When parsing', () => {
      it('Then throws INVALID_REF', () => {
        // Arrange
        try {
          parseLooseRef('');
          // Assert
          expect.fail('should have thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(TsgitError);
          expect((e as TsgitError).data.code).toBe('INVALID_REF');
          expect((e as TsgitError).data).toHaveProperty('reason', 'empty ref content');
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

  describe("Given 'ref: ' (empty target)", () => {
    describe('When parsing', () => {
      it('Then throws INVALID_REF', () => {
        // Arrange
        try {
          parseLooseRef('ref: ');
          // Assert
          expect.fail('should have thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(TsgitError);
          expect((e as TsgitError).data.code).toBe('INVALID_REF');
          expect((e as TsgitError).data).toHaveProperty('reason', 'empty symbolic ref target');
        }
      });
    });
  });

  describe("Given 'ref: \\\\n' (whitespace-only target after trim)", () => {
    describe('When parsing', () => {
      it('Then throws INVALID_REF', () => {
        // Arrange
        try {
          parseLooseRef('ref: \n');
          // Assert
          expect.fail('should have thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(TsgitError);
          expect((e as TsgitError).data.code).toBe('INVALID_REF');
          expect((e as TsgitError).data).toHaveProperty('reason', 'empty symbolic ref target');
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
