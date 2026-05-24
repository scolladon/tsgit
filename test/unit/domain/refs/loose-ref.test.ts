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
  it("Given '<40-char-sha>\\n', When parsing, Then returns DirectRef with correct ObjectId", () => {
    // Arrange
    const content = `${SHA1}\n`;

    // Act
    const sut = parseLooseRef(content);

    // Assert
    expect(sut).toEqual({ type: 'direct', target: SHA1 });
  });

  it("Given '<64-char-sha>\\n' (SHA-256), When parsing, Then returns DirectRef", () => {
    // Arrange
    const content = `${SHA256}\n`;

    // Act
    const sut = parseLooseRef(content);

    // Assert
    expect(sut).toEqual({ type: 'direct', target: SHA256 });
  });

  it("Given 'ref: refs/heads/main\\n', When parsing, Then returns SymbolicRef with target 'refs/heads/main'", () => {
    // Arrange
    const content = 'ref: refs/heads/main\n';

    // Act
    const sut = parseLooseRef(content);

    // Assert
    expect(sut).toEqual({ type: 'symbolic', target: 'refs/heads/main' });
  });

  it("Given '<sha>\\r\\n', When parsing, Then handles CRLF gracefully", () => {
    // Arrange
    const content = `${SHA1}\r\n`;

    // Act
    const sut = parseLooseRef(content);

    // Assert
    expect(sut).toEqual({ type: 'direct', target: SHA1 });
  });

  it("Given '<sha>' (no trailing newline), When parsing, Then handles gracefully", () => {
    // Arrange
    const content = SHA1 as string;

    // Act
    const sut = parseLooseRef(content);

    // Assert
    expect(sut).toEqual({ type: 'direct', target: SHA1 });
  });

  it("Given 'ref: refs/heads/main' (no newline), When parsing, Then handles gracefully", () => {
    // Arrange
    const content = 'ref: refs/heads/main';

    // Act
    const sut = parseLooseRef(content);

    // Assert
    expect(sut).toEqual({ type: 'symbolic', target: 'refs/heads/main' });
  });

  it("Given '' (empty), When parsing, Then throws INVALID_REF", () => {
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

  it("Given 'not-a-sha', When parsing, Then throws INVALID_OBJECT_ID", () => {
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

  it("Given 'ref: ' (empty target), When parsing, Then throws INVALID_REF", () => {
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

  it("Given 'ref: \\n' (whitespace-only target after trim), When parsing, Then throws INVALID_REF", () => {
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

  it("Given 'ref: ../../../etc/passwd\\n' (path traversal), When parsing, Then throws INVALID_REF", () => {
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

  it('Given content with embedded newline before trailing newline, When parsing, Then only trailing newlines are stripped', () => {
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

  it('Given a symbolic ref with an embedded newline and NO trailing newline, When parsing, Then the embedded newline is preserved and rejected', () => {
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

describe('serializeDirectRef', () => {
  it("Given any ObjectId, When serializing, Then result is '<sha>\\n'", () => {
    // Arrange & Act
    const sut = serializeDirectRef(SHA1);

    // Assert
    expect(sut).toBe(`${SHA1}\n`);
  });
});

describe('serializeSymbolicRef', () => {
  it("Given any RefName, When serializing, Then result is 'ref: <name>\\n'", () => {
    // Arrange
    const target = 'refs/heads/main' as RefName;

    // Act
    const sut = serializeSymbolicRef(target);

    // Assert
    expect(sut).toBe('ref: refs/heads/main\n');
  });
});

describe('roundtrip', () => {
  it('Given any ObjectId, When serializing then parsing, Then roundtrips', () => {
    // Arrange + Assert
    fc.assert(
      fc.property(arbObjectId(), (id) => {
        const sut = parseLooseRef(serializeDirectRef(id));
        expect(sut).toEqual({ type: 'direct', target: id });
      }),
    );
  });

  it('Given any RefName (via arbRefName), When serializing symbolic then parsing, Then roundtrips', () => {
    // Arrange + Assert
    fc.assert(
      fc.property(arbRefName(), (name) => {
        const sut = parseLooseRef(serializeSymbolicRef(name));
        expect(sut).toEqual({ type: 'symbolic', target: name });
      }),
    );
  });
});
