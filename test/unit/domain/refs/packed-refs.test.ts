import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { TsgitError } from '../../../../src/domain/error.js';
import type { ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import { parsePackedRefs, serializePackedRefs } from '../../../../src/domain/refs/packed-refs.js';
import type { PackedRefEntry, PackedRefs } from '../../../../src/domain/refs/ref-types.js';
import { arbObjectId } from '../objects/arbitraries.js';
import { arbRefName } from './arbitraries.js';

const SHA1 = 'a'.repeat(40) as ObjectId;
const SHA2 = 'b'.repeat(40) as ObjectId;
const SHA3 = 'c'.repeat(40) as ObjectId;
const SHA4 = 'd'.repeat(40) as ObjectId;

describe('parsePackedRefs', () => {
  describe('Given empty string', () => {
    describe('When parsing', () => {
      it("Then returns empty entries, peeling='none', sorted=false", () => {
        // Arrange & Act
        const sut = parsePackedRefs('');

        // Assert
        expect(sut).toEqual({ entries: [], peeling: 'none', sorted: false });
      });
    });
  });

  describe('Given a pack-refs header with varying trait combinations', () => {
    describe('When parsing', () => {
      it.each([
        {
          content: '# pack-refs with: peeled fully-peeled sorted\n',
          peeling: 'fully',
          sorted: true,
          label: "'peeled fully-peeled sorted' yields peeling='fully', sorted=true",
        },
        {
          content: '# pack-refs with: peeled sorted\n',
          peeling: 'tags',
          sorted: true,
          label: "'peeled sorted' yields peeling='tags', sorted=true",
        },
        {
          content: `# pack-refs with:  sorted\n${'a'.repeat(40)} refs/heads/main\n`,
          peeling: 'none',
          sorted: true,
          label: 'extra whitespace before sorted still yields sorted=true',
        },
        {
          content: `# pack-refs with: peeled\n${'a'.repeat(40)} refs/heads/main\n`,
          peeling: 'tags',
          sorted: false,
          label: "only the 'peeled' trait yields peeling='tags', sorted=false",
        },
        {
          content: '# pack-refs with: sorted\n',
          peeling: 'none',
          sorted: true,
          label: "'sorted' alone yields peeling='none', sorted=true",
        },
      ] as const)('Then $label', ({ content, peeling, sorted }) => {
        // Arrange & Act
        const sut = parsePackedRefs(content);

        // Assert
        expect(sut.peeling).toBe(peeling);
        expect(sut.sorted).toBe(sorted);
      });
    });
  });

  describe("Given '# pack-refs with:\\\\n' (no traits)", () => {
    describe('When parsing', () => {
      it("Then peeling='none', sorted=false", () => {
        // Arrange
        const content = `# pack-refs with:\n${'a'.repeat(40)} refs/heads/main\n`;

        // Act
        const sut = parsePackedRefs(content);

        // Assert
        expect(sut.peeling).toBe('none');
        expect(sut.sorted).toBe(false);
        expect(sut.entries).toHaveLength(1);
      });
    });
  });

  describe('Given 3 ref lines', () => {
    describe('When parsing', () => {
      it('Then returns 3 entries with correct SHAs and names', () => {
        // Arrange
        const content = [
          '# pack-refs with: peeled fully-peeled sorted',
          `${SHA1} refs/heads/main`,
          `${SHA2} refs/heads/develop`,
          `${SHA3} refs/tags/v1.0`,
          '',
        ].join('\n');

        // Act
        const sut = parsePackedRefs(content);

        // Assert
        expect(sut.entries).toHaveLength(3);
        expect(sut.entries[0]).toEqual({ name: 'refs/heads/main', id: SHA1 });
        expect(sut.entries[1]).toEqual({ name: 'refs/heads/develop', id: SHA2 });
        expect(sut.entries[2]).toEqual({ name: 'refs/tags/v1.0', id: SHA3 });
      });
    });
  });

  describe('Given ref line followed by ^<sha>', () => {
    describe('When parsing', () => {
      it('Then entry has peeled field', () => {
        // Arrange
        const content = [
          '# pack-refs with: peeled fully-peeled sorted',
          `${SHA1} refs/tags/v1.0`,
          `^${SHA4}`,
          '',
        ].join('\n');

        // Act
        const sut = parsePackedRefs(content);

        // Assert
        expect(sut.entries[0]).toEqual({ name: 'refs/tags/v1.0', id: SHA1, peeled: SHA4 });
      });
    });
  });

  describe('Given ref line without peel', () => {
    describe('When parsing', () => {
      it('Then peeled is undefined', () => {
        // Arrange
        const content = `${SHA1} refs/heads/main\n`;

        // Act
        const sut = parsePackedRefs(content);

        // Assert
        expect(sut.entries[0]?.peeled).toBeUndefined();
      });
    });
  });

  describe('Given peel line present without header trait', () => {
    describe('When parsing', () => {
      it('Then peel line still accepted', () => {
        // Arrange
        const content = [`${SHA1} refs/tags/v1.0`, `^${SHA4}`, ''].join('\n');

        // Act
        const sut = parsePackedRefs(content);

        // Assert
        expect(sut.peeling).toBe('none');
        expect(sut.entries[0]?.peeled).toBe(SHA4);
      });
    });
  });

  describe('Given multiple comment lines', () => {
    describe('When parsing', () => {
      it('Then comments skipped', () => {
        // Arrange
        const content = [
          '# pack-refs with: sorted',
          '# some other comment',
          `${SHA1} refs/heads/main`,
          '',
        ].join('\n');

        // Act
        const sut = parsePackedRefs(content);

        // Assert
        expect(sut.entries).toHaveLength(1);
      });
    });
  });

  describe('Given invalid SHA in ref line', () => {
    describe('When parsing', () => {
      it('Then throws INVALID_OBJECT_ID', () => {
        // Arrange
        const content = 'invalidsha refs/heads/main\n';

        // Act & Assert
        try {
          parsePackedRefs(content);
          // Assert
          expect.fail('should have thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(TsgitError);
          expect((e as TsgitError).data.code).toBe('INVALID_OBJECT_ID');
        }
      });
    });
  });

  describe('Given peel line without preceding ref', () => {
    describe('When parsing', () => {
      it('Then throws INVALID_PACKED_REFS', () => {
        // Arrange
        const content = ['# pack-refs with: sorted', `^${SHA1}`, ''].join('\n');

        // Act & Assert
        try {
          parsePackedRefs(content);
          // Assert
          expect.fail('should have thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(TsgitError);
          expect((e as TsgitError).data.code).toBe('INVALID_PACKED_REFS');
          expect((e as TsgitError).data).toHaveProperty(
            'reason',
            'peel line without preceding ref entry',
          );
        }
      });
    });
  });

  describe('Given line with wrong format (no space)', () => {
    describe('When parsing', () => {
      it('Then throws INVALID_PACKED_REFS with reason', () => {
        // Arrange
        const content = `${'a'.repeat(40)}nospace\n`;

        // Act & Assert
        try {
          parsePackedRefs(content);
          // Assert
          expect.fail('should have thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(TsgitError);
          expect((e as TsgitError).data.code).toBe('INVALID_PACKED_REFS');
          expect(((e as TsgitError).data as { reason: string }).reason).toContain(
            'invalid ref line format:',
          );
        }
      });
    });
  });

  describe('Given a no-space line longer than 80 chars', () => {
    describe('When parsing', () => {
      it('Then error reason truncates the line at 80 chars', () => {
        // Arrange — line has no space; 120 hex chars so slice(0, 80) is observable
        const line = 'a'.repeat(120);
        const content = `${line}\n`;

        // Act & Assert
        try {
          parsePackedRefs(content);
          // Assert
          expect.fail('should have thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(TsgitError);
          expect((e as TsgitError).data.code).toBe('INVALID_PACKED_REFS');
          expect(((e as TsgitError).data as { reason: string }).reason).toBe(
            `invalid ref line format: ${'a'.repeat(80)}`,
          );
        }
      });
    });
  });

  describe('Given content without header line (starts with ref)', () => {
    describe('When parsing', () => {
      it('Then sorted=false and peeling=none', () => {
        // Arrange — no "# pack-refs with:" header
        const content = `${'a'.repeat(40)} refs/heads/main\n`;

        // Act
        const sut = parsePackedRefs(content);

        // Assert
        expect(sut.sorted).toBe(false);
        expect(sut.peeling).toBe('none');
        expect(sut.entries).toHaveLength(1);
      });
    });
  });
});

describe('serializePackedRefs', () => {
  describe('Given entries in non-sorted order', () => {
    describe('When serializing', () => {
      it('Then output is sorted by name', () => {
        // Arrange
        const refs: PackedRefs = {
          entries: [
            { name: 'refs/tags/v1.0' as RefName, id: SHA2 },
            { name: 'refs/heads/main' as RefName, id: SHA1 },
          ],
          peeling: 'none',
          sorted: true,
        };

        // Act
        const sut = serializePackedRefs(refs);

        // Assert
        const lines = sut.split('\n');
        expect(lines[1]).toContain('refs/heads/main');
        expect(lines[2]).toContain('refs/tags/v1.0');
      });
    });
  });

  describe('Given entries with peeled', () => {
    describe('When serializing', () => {
      it('Then header includes peeled trait', () => {
        // Arrange
        const refs: PackedRefs = {
          entries: [{ name: 'refs/tags/v1.0' as RefName, id: SHA1, peeled: SHA4 }],
          peeling: 'tags',
          sorted: true,
        };

        // Act
        const sut = serializePackedRefs(refs);

        // Assert
        expect(sut).toContain('# pack-refs with: peeled sorted');
        expect(sut).toContain(`^${SHA4}`);
      });
    });
  });

  describe('Given entries with duplicate names', () => {
    describe('When serializing', () => {
      it('Then both appear in output', () => {
        // Arrange
        const refs: PackedRefs = {
          entries: [
            { name: 'refs/heads/main' as RefName, id: SHA1 },
            { name: 'refs/heads/main' as RefName, id: SHA2 },
          ],
          peeling: 'none',
          sorted: true,
        };

        // Act
        const sut = serializePackedRefs(refs);

        // Assert
        const refLines = sut.split('\n').filter((l) => !l.startsWith('#') && l !== '');
        expect(refLines).toHaveLength(2);
      });
    });
  });

  describe('Given two entries with equal names', () => {
    describe('When serializing', () => {
      it('Then their input order is preserved (stable sort)', () => {
        // Arrange — equal names force the comparator's `=== 0` branch; a `<=` mutant
        // would return -1 here and reverse the pair
        const refs: PackedRefs = {
          entries: [
            { name: 'refs/heads/main' as RefName, id: SHA1 },
            { name: 'refs/heads/main' as RefName, id: SHA2 },
          ],
          peeling: 'none',
          sorted: false,
        };

        // Act
        const sut = serializePackedRefs(refs);

        // Assert
        const refLines = sut.split('\n').filter((l) => !l.startsWith('#') && l !== '');
        expect(refLines[0]).toBe(`${SHA1} refs/heads/main`);
        expect(refLines[1]).toBe(`${SHA2} refs/heads/main`);
      });
    });
  });

  describe("Given peeling='fully'", () => {
    describe('When serializing', () => {
      it('Then header includes both peeled and fully-peeled', () => {
        // Arrange
        const refs: PackedRefs = {
          entries: [{ name: 'refs/heads/main' as RefName, id: SHA1 }],
          peeling: 'fully',
          sorted: false,
        };

        // Act
        const sut = serializePackedRefs(refs);

        // Assert
        const headerLine = sut.split('\n')[0];
        // Canonical git emits a trailing space after the trait list; tsgit
        // matches that for byte-identical interop (ADR-140).
        expect(headerLine).toBe('# pack-refs with: peeled fully-peeled ');
      });
    });
  });

  describe('Given peeling=none and sorted=false', () => {
    describe('When serializing', () => {
      it('Then header has no traits', () => {
        // Arrange
        const refs: PackedRefs = {
          entries: [{ name: 'refs/heads/main' as RefName, id: SHA1 }],
          peeling: 'none',
          sorted: false,
        };

        // Act
        const sut = serializePackedRefs(refs);

        // Assert — header line should have no traits after the prefix
        const headerLine = sut.split('\n')[0];
        expect(headerLine).toBe('# pack-refs with:');
      });
    });
  });

  describe('Given empty entries', () => {
    describe('When serializing', () => {
      it('Then returns empty string', () => {
        // Arrange
        const refs: PackedRefs = { entries: [], peeling: 'none', sorted: false };

        // Act
        const sut = serializePackedRefs(refs);

        // Assert
        expect(sut).toBe('');
      });
    });
  });
});

describe('roundtrip', () => {
  describe('Given serialized then parsed PackedRefs', () => {
    describe('When roundtripping', () => {
      it('Then all entries and traits preserved', () => {
        // Arrange
        const original: PackedRefs = {
          entries: [
            { name: 'refs/heads/develop' as RefName, id: SHA2 },
            { name: 'refs/heads/main' as RefName, id: SHA1 },
            { name: 'refs/tags/v1.0' as RefName, id: SHA3, peeled: SHA4 },
          ],
          peeling: 'fully',
          sorted: true,
        };

        // Act
        const serialized = serializePackedRefs(original);
        const sut = parsePackedRefs(serialized);

        // Assert
        expect(sut.peeling).toBe('fully');
        expect(sut.sorted).toBe(true);
        const sorted = [...original.entries].sort((a, b) =>
          (a.name as string) < (b.name as string)
            ? -1
            : (a.name as string) > (b.name as string)
              ? 1
              : 0,
        );
        expect(sut.entries).toEqual(sorted);
      });
    });
  });

  describe('Given arbitrary entries', () => {
    describe('When serializing then parsing', () => {
      it('Then all entries preserved', () => {
        // Arrange + Assert
        fc.assert(
          fc.property(
            fc.array(
              fc
                .tuple(arbRefName(), arbObjectId())
                .map(([name, id]): PackedRefEntry => ({ name, id })),
              { minLength: 1, maxLength: 10 },
            ),
            (entries) => {
              const uniqueEntries = deduplicateByName(entries);
              const refs: PackedRefs = { entries: uniqueEntries, peeling: 'fully', sorted: true };
              const serialized = serializePackedRefs(refs);
              const parsed = parsePackedRefs(serialized);

              const sortedOriginal = [...uniqueEntries].sort((a, b) =>
                (a.name as string) < (b.name as string)
                  ? -1
                  : (a.name as string) > (b.name as string)
                    ? 1
                    : 0,
              );
              expect(parsed.entries).toEqual(sortedOriginal);
            },
          ),
        );
      });
    });
  });
});

function deduplicateByName(entries: ReadonlyArray<PackedRefEntry>): ReadonlyArray<PackedRefEntry> {
  const seen = new Set<string>();
  return entries.filter((e) => {
    if (seen.has(e.name as string)) return false;
    seen.add(e.name as string);
    return true;
  });
}
