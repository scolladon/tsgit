import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { TsgitError } from '../../../../src/domain/error.js';
import type { ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import {
  parseLooseRef,
  readLooseBody,
  serializeDirectRef,
  serializeSymbolicRef,
} from '../../../../src/domain/refs/loose-ref.js';
import { arbObjectId } from '../objects/arbitraries.js';
import { arbRefName } from './arbitraries.js';

const SHA1 = 'a'.repeat(40) as ObjectId;
const SHA256 = 'b'.repeat(64) as ObjectId;

describe('readLooseBody', () => {
  describe('Given an upper-case direct oid with a newline', () => {
    describe('When read with hexLength 40', () => {
      it('Then it is direct with the lower-case id', () => {
        // Arrange
        const content = `${'A'.repeat(40)}\n`;
        const sut = readLooseBody;

        // Act
        const result = sut(content, 40);

        // Assert
        expect(result).toEqual({ kind: 'direct', id: SHA1, missingNewline: false });
      });
    });
  });
});

describe('readLooseBody (grammar classes)', () => {
  const SHA = 'a'.repeat(40);

  describe('Given a direct oid followed by a trailer', () => {
    describe('When read', () => {
      it.each([
        { content: `${SHA} garbage\n`, trailing: ' garbage\n', missingNewline: false },
        { content: `${SHA}\n\n`, trailing: '\n\n', missingNewline: false },
        { content: `${SHA}\t\n`, trailing: '\t\n', missingNewline: false },
        { content: `${SHA}\r\n`, trailing: '\r\n', missingNewline: false },
        { content: `${SHA} garbage`, trailing: ' garbage', missingNewline: false },
      ])('Then it keeps the id and reports the trailer of $content', (row) => {
        // Arrange
        const sut = readLooseBody;

        // Act
        const result = sut(row.content, 40);

        // Assert
        expect(result).toEqual({
          kind: 'direct',
          id: SHA1,
          missingNewline: row.missingNewline,
          trailing: row.trailing,
        });
      });
    });
  });

  describe('Given a direct oid with no trailer', () => {
    describe('When read', () => {
      it('Then it is direct, misses its newline and carries no trailer', () => {
        // Arrange
        const sut = readLooseBody;

        // Act
        const result = sut(SHA, 40);

        // Assert
        expect(result).toEqual({ kind: 'direct', id: SHA1, missingNewline: true });
      });
    });
  });

  describe('Given content that is not a ref body', () => {
    describe('When read', () => {
      it.each([
        { label: 'oid glued to garbage', content: `${SHA}garbage\n` },
        { label: '39 hex digits', content: `${'a'.repeat(39)}\n` },
        { label: '39 hex digits with no line feed', content: 'a'.repeat(39) },
        { label: '41 hex digits', content: `${SHA}0\n` },
        { label: '64 hex digits at width 40', content: `${'a'.repeat(64)}\n` },
        { label: 'a vertical tab after the oid', content: `${SHA}\v\n` },
        { label: 'empty content', content: '' },
      ])('Then $label is unparseable', ({ content }) => {
        // Arrange
        const sut = readLooseBody;

        // Act
        const result = sut(content, 40);

        // Assert
        expect(result).toEqual({ kind: 'unparseable' });
      });
    });
  });

  describe('Given a symbolic body', () => {
    describe('When read', () => {
      it.each([
        { content: 'ref:refs/heads/main\n', referent: 'refs/heads/main', nl: false, tw: false },
        { content: 'ref:\trefs/heads/main\n', referent: 'refs/heads/main', nl: false, tw: false },
        { content: 'ref: refs/heads/main \n', referent: 'refs/heads/main', nl: false, tw: true },
        { content: 'ref: refs/heads/main\r\n', referent: 'refs/heads/main', nl: false, tw: true },
        { content: 'ref: refs/heads/main', referent: 'refs/heads/main', nl: true, tw: false },
        { content: 'ref: refs/heads/main ', referent: 'refs/heads/main', nl: true, tw: false },
        { content: 'ref: ', referent: '', nl: true, tw: false },
        { content: 'ref: \n', referent: '', nl: true, tw: false },
        { content: 'ref: \n\n', referent: '', nl: true, tw: false },
        { content: 'ref:', referent: '', nl: true, tw: false },
        {
          content: 'ref: refs/heads/main\nextra\n',
          referent: 'refs/heads/main\nextra',
          nl: false,
          tw: false,
        },
        {
          content: 'ref:\vrefs/heads/main\n',
          referent: '\vrefs/heads/main',
          nl: false,
          tw: false,
        },
      ])('Then $content reads as a symref', (row) => {
        // Arrange
        const sut = readLooseBody;

        // Act
        const result = sut(row.content, 40);

        // Assert
        expect(result).toEqual({
          kind: 'symbolic',
          referent: row.referent,
          missingNewline: row.nl,
          trailingWhitespace: row.tw,
        });
      });
    });
  });
});

describe('parseLooseRef', () => {
  describe('Given loose-ref content encoding a direct ref', () => {
    describe('When parsing', () => {
      it.each([
        { content: `${SHA1}\n`, target: SHA1, label: 'returns DirectRef with correct ObjectId' },
        {
          content: `${SHA256}\n`,
          target: SHA256,
          hexLength: 64 as const,
          label: 'returns DirectRef for a SHA-256 id',
        },
        { content: `${SHA1}\r\n`, target: SHA1, label: 'handles CRLF gracefully' },
        {
          content: SHA1 as string,
          target: SHA1,
          label: 'handles a missing trailing newline gracefully',
        },
      ])('Then $label', ({ content, target, hexLength }) => {
        // Arrange
        const sut = parseLooseRef;

        // Act
        const result = sut(content, hexLength ?? 40);

        // Assert
        expect(result).toEqual({ type: 'direct', target });
      });
    });
  });

  describe('Given git-lenient loose-ref content', () => {
    describe('When parsing at hexLength 40', () => {
      it('Then a symref without a space after the keyword is symbolic', () => {
        // Arrange
        const sut = parseLooseRef;

        // Act
        const result = sut('ref:refs/heads/main\n', 40);

        // Assert
        expect(result).toEqual({ type: 'symbolic', target: 'refs/heads/main' });
      });

      it('Then an upper-case oid is direct with the lower-case id', () => {
        // Arrange
        const sut = parseLooseRef;

        // Act
        const result = sut(`${'A'.repeat(40)}\n`, 40);

        // Assert
        expect(result).toEqual({ type: 'direct', target: SHA1 });
      });

      it('Then a 64-digit oid is refused with INVALID_OBJECT_ID', () => {
        // Arrange
        const sut = parseLooseRef;
        let thrown: unknown;

        // Act
        try {
          sut(`${'a'.repeat(64)}\n`, 40);
        } catch (e) {
          thrown = e;
        }

        // Assert
        expect((thrown as TsgitError).data.code).toBe('INVALID_OBJECT_ID');
      });
    });
  });

  describe("Given 'ref: refs/heads/main\\\\n'", () => {
    describe('When parsing', () => {
      it("Then returns SymbolicRef with target 'refs/heads/main'", () => {
        // Arrange
        const content = 'ref: refs/heads/main\n';

        // Act
        const result = parseLooseRef(content, 40);

        // Assert
        expect(result).toEqual({ type: 'symbolic', target: 'refs/heads/main' });
      });
    });
  });

  describe("Given 'ref: refs/heads/main' (no newline)", () => {
    describe('When parsing', () => {
      it('Then handles gracefully', () => {
        // Arrange
        const content = 'ref: refs/heads/main';

        // Act
        const result = parseLooseRef(content, 40);

        // Assert
        expect(result).toEqual({ type: 'symbolic', target: 'refs/heads/main' });
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
          parseLooseRef(content, 40);
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
          parseLooseRef('not-a-sha', 40);
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
          parseLooseRef('ref: ../../../etc/passwd\n', 40);
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
          parseLooseRef(content, 40);
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
          parseLooseRef(content, 40);
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
        const result = serializeDirectRef(SHA1);

        // Assert
        expect(result).toBe(`${SHA1}\n`);
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
        const result = serializeSymbolicRef(target);

        // Assert
        expect(result).toBe('ref: refs/heads/main\n');
      });
    });
  });
});

describe('roundtrip', () => {
  describe('Given any ObjectId', () => {
    describe('When serializing then parsing', () => {
      it('Then roundtrips', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbObjectId(), (id) => {
            const result = parseLooseRef(serializeDirectRef(id), 40);
            expect(result).toEqual({ type: 'direct', target: id });
          }),
        );
      });
    });
  });

  describe('Given any RefName (via arbRefName)', () => {
    describe('When serializing symbolic then parsing', () => {
      it('Then roundtrips', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbRefName(), (name) => {
            const result = parseLooseRef(serializeSymbolicRef(name), 40);
            expect(result).toEqual({ type: 'symbolic', target: name });
          }),
        );
      });
    });
  });
});
