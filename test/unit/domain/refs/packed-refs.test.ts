import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { TsgitError } from '../../../../src/domain/error.js';
import type { ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import {
  packedRefsWithout,
  parsePackedRefs,
  serializePackedRefs,
} from '../../../../src/domain/refs/packed-refs.js';
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
        const result = parsePackedRefs('');

        // Assert
        expect(result).toEqual({ entries: [], peeling: 'none', sorted: false });
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
        const result = parsePackedRefs(content);

        // Assert
        expect(result.peeling).toBe(peeling);
        expect(result.sorted).toBe(sorted);
      });
    });
  });

  describe("Given '# pack-refs with:\\\\n' (no traits)", () => {
    describe('When parsing', () => {
      it("Then peeling='none', sorted=false", () => {
        // Arrange
        const content = `# pack-refs with:\n${'a'.repeat(40)} refs/heads/main\n`;

        // Act
        const result = parsePackedRefs(content);

        // Assert
        expect(result.peeling).toBe('none');
        expect(result.sorted).toBe(false);
        expect(result.entries).toHaveLength(1);
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
        const result = parsePackedRefs(content);

        // Assert
        expect(result.entries).toHaveLength(3);
        expect(result.entries[0]).toEqual({ name: 'refs/heads/main', id: SHA1 });
        expect(result.entries[1]).toEqual({ name: 'refs/heads/develop', id: SHA2 });
        expect(result.entries[2]).toEqual({ name: 'refs/tags/v1.0', id: SHA3 });
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
        const result = parsePackedRefs(content);

        // Assert
        expect(result.entries[0]).toEqual({ name: 'refs/tags/v1.0', id: SHA1, peeled: SHA4 });
      });
    });
  });

  describe('Given ref line without peel', () => {
    describe('When parsing', () => {
      it('Then peeled is undefined', () => {
        // Arrange
        const content = `${SHA1} refs/heads/main\n`;

        // Act
        const result = parsePackedRefs(content);

        // Assert
        expect(result.entries[0]?.peeled).toBeUndefined();
      });
    });
  });

  describe('Given peel line present without header trait', () => {
    describe('When parsing', () => {
      it('Then peel line still accepted', () => {
        // Arrange
        const content = [`${SHA1} refs/tags/v1.0`, `^${SHA4}`, ''].join('\n');

        // Act
        const result = parsePackedRefs(content);

        // Assert
        expect(result.peeling).toBe('none');
        expect(result.entries[0]?.peeled).toBe(SHA4);
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
        const result = parsePackedRefs(content);

        // Assert
        expect(result.entries).toHaveLength(1);
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
        const result = parsePackedRefs(content);

        // Assert
        expect(result.sorted).toBe(false);
        expect(result.peeling).toBe('none');
        expect(result.entries).toHaveLength(1);
      });
    });
  });

  describe('Given a packed ref entry with a dangerous name (path-traversal via ..)', () => {
    describe('When parsing', () => {
      it('Then throws INVALID_PACKED_REFS naming the dangerous refname', () => {
        // Arrange — matches git 2.55.0: `fatal: packed refname is dangerous:
        // refs/remotes/origin/../../../../tmp/pwned`. Git refuses the whole
        // read; tsgit must refuse at the same seam, not merely fail to
        // traverse later.
        const dangerous = 'refs/remotes/origin/../../../../tmp/pwned';
        const content = `${'a'.repeat(40)} ${dangerous}\n`;

        // Act & Assert
        try {
          parsePackedRefs(content);
          expect.fail('should have thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(TsgitError);
          expect((e as TsgitError).data.code).toBe('INVALID_PACKED_REFS');
          expect(((e as TsgitError).data as { reason: string }).reason).toContain(dangerous);
        }
      });
    });
  });

  describe('Given a packed ref entry with a dangerous name (.lock component)', () => {
    describe('When parsing', () => {
      it('Then throws INVALID_PACKED_REFS, isolated from the .. guard', () => {
        // Arrange — a distinct dangerous shape (no `..` anywhere) so this
        // guard is proven independently of the path-traversal guard above;
        // one test triggering both would not prove each works alone.
        const dangerous = 'refs/remotes/origin/foo.lock';
        const content = `${'a'.repeat(40)} ${dangerous}\n`;

        // Act & Assert
        try {
          parsePackedRefs(content);
          expect.fail('should have thrown');
        } catch (e) {
          expect(e).toBeInstanceOf(TsgitError);
          expect((e as TsgitError).data.code).toBe('INVALID_PACKED_REFS');
          expect(((e as TsgitError).data as { reason: string }).reason).toContain(dangerous);
        }
      });
    });
  });

  describe('Given a well-formed nested packed ref name', () => {
    describe('When parsing', () => {
      it('Then it still parses (regression guard against over-rejection)', () => {
        // Arrange — the dangerous-name guard must not over-reject ordinary
        // nested remote-tracking names.
        const content = `${'a'.repeat(40)} refs/remotes/origin/feat/x\n`;

        // Act
        const result = parsePackedRefs(content);

        // Assert
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0]).toEqual({
          name: 'refs/remotes/origin/feat/x',
          id: 'a'.repeat(40),
        });
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
        const result = serializePackedRefs(refs);

        // Assert
        const lines = result.split('\n');
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
        const result = serializePackedRefs(refs);

        // Assert
        expect(result).toContain('# pack-refs with: peeled sorted');
        expect(result).toContain(`^${SHA4}`);
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
        const result = serializePackedRefs(refs);

        // Assert
        const refLines = result.split('\n').filter((l) => !l.startsWith('#') && l !== '');
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
        const result = serializePackedRefs(refs);

        // Assert
        const refLines = result.split('\n').filter((l) => !l.startsWith('#') && l !== '');
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
        const result = serializePackedRefs(refs);

        // Assert
        const headerLine = result.split('\n')[0];
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
        const result = serializePackedRefs(refs);

        // Assert — header line should have no traits after the prefix
        const headerLine = result.split('\n')[0];
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
        const result = serializePackedRefs(refs);

        // Assert
        expect(result).toBe('');
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
        const result = parsePackedRefs(serialized);

        // Assert
        expect(result.peeling).toBe('fully');
        expect(result.sorted).toBe(true);
        const sorted = [...original.entries].sort((a, b) =>
          (a.name as string) < (b.name as string)
            ? -1
            : (a.name as string) > (b.name as string)
              ? 1
              : 0,
        );
        expect(result.entries).toEqual(sorted);
      });
    });
  });

  describe('Given arbitrary entries', () => {
    describe('When serializing then parsing', () => {
      it('Then all entries preserved', () => {
        // Arrange + Act + Assert
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

describe('packedRefsWithout', () => {
  describe('Given a file with an annotated tag among plain refs', () => {
    describe('When the annotated tag is removed', () => {
      it('Then the entry and its peeled line are both gone, the survivor kept', () => {
        // Arrange
        const { entries } = parsePackedRefs(
          [
            '# pack-refs with: peeled fully-peeled sorted ',
            `${SHA1} refs/heads/main`,
            `${SHA2} refs/tags/v1.0`,
            `^${SHA4}`,
            '',
          ].join('\n'),
        );
        const sut = packedRefsWithout;

        // Act
        const result = sut(entries, new Set(['refs/tags/v1.0' as RefName]));

        // Assert
        expect(result.entries).toEqual([{ name: 'refs/heads/main', id: SHA1 }]);
        expect(result.content).toBe(
          `# pack-refs with: peeled fully-peeled sorted \n${SHA1} refs/heads/main\n`,
        );
      });
    });
  });

  describe('Given several names to remove at once', () => {
    describe('When packedRefsWithout runs', () => {
      it('Then every named entry is gone in one rewrite and the others survive', () => {
        // Arrange
        const entries: ReadonlyArray<PackedRefEntry> = [
          { name: 'refs/heads/a' as RefName, id: SHA1 },
          { name: 'refs/heads/b' as RefName, id: SHA2 },
          { name: 'refs/tags/c' as RefName, id: SHA3, peeled: SHA4 },
        ];
        const sut = packedRefsWithout;

        // Act
        const result = sut(entries, new Set(['refs/heads/a', 'refs/tags/c'] as RefName[]));

        // Assert
        expect(result.entries).toEqual([{ name: 'refs/heads/b', id: SHA2 }]);
        expect(result.content).toBe(
          `# pack-refs with: peeled fully-peeled sorted \n${SHA2} refs/heads/b\n`,
        );
      });
    });
  });

  describe('Given a header-less packed-refs file', () => {
    describe('When an entry is removed', () => {
      it('Then the rewrite gains the canonical header', () => {
        // Arrange
        const { entries } = parsePackedRefs(
          [`${SHA1} refs/heads/main`, `${SHA2} refs/heads/other`, ''].join('\n'),
        );
        const sut = packedRefsWithout;

        // Act
        const result = sut(entries, new Set(['refs/heads/other' as RefName]));

        // Assert
        expect(result.content.split('\n')[0]).toBe('# pack-refs with: peeled fully-peeled sorted ');
      });
    });
  });

  describe('Given entries in an order that is not sorted', () => {
    describe('When a name the ordered walk steps past is removed', () => {
      it('Then every line survives and the rewrite keeps the order it was given', () => {
        // Arrange — the walk over the names to drop only ever moves forward,
        // so `mmm` is already behind it by the time its own line comes up.
        const { entries } = parsePackedRefs(
          [`${SHA1} refs/heads/zzz`, `${SHA2} refs/heads/aaa`, `${SHA3} refs/heads/mmm`, ''].join(
            '\n',
          ),
        );
        const sut = packedRefsWithout;

        // Act
        const result = sut(entries, new Set(['refs/heads/mmm' as RefName]));

        // Assert
        expect(parsePackedRefs(result.content).entries.map((e) => e.name)).toEqual([
          'refs/heads/zzz',
          'refs/heads/aaa',
          'refs/heads/mmm',
        ]);
        expect(result.entries.map((e) => e.name)).toEqual([
          'refs/heads/zzz',
          'refs/heads/aaa',
          'refs/heads/mmm',
        ]);
      });
    });
  });

  describe('Given a header claiming only the "peeled" trait', () => {
    describe('When an entry is removed', () => {
      it("Then the rewrite replaces it with git's canonical header", () => {
        // Arrange
        const { entries } = parsePackedRefs(
          [
            '# pack-refs with: peeled',
            `${SHA1} refs/heads/main`,
            `${SHA2} refs/heads/other`,
            '',
          ].join('\n'),
        );
        const sut = packedRefsWithout;

        // Act
        const result = sut(entries, new Set(['refs/heads/other' as RefName]));

        // Assert
        expect(result.content.split('\n')[0]).toBe('# pack-refs with: peeled fully-peeled sorted ');
      });
    });
  });

  describe('Given an entry naming a missing object and an annotated tag with no peel line', () => {
    describe('When an unrelated entry is removed', () => {
      it('Then both survivors are copied unchanged — no object is read, no peeling happens', () => {
        // Arrange — a well-formed but unresolvable SHA, and a tag entry that
        // (unusually) carries no `^` line of its own.
        const { entries } = parsePackedRefs(
          [
            '# pack-refs with: peeled fully-peeled sorted ',
            `${SHA1} refs/heads/gone-object`,
            `${SHA3} refs/heads/victim`,
            `${SHA2} refs/tags/unpeeled`,
            '',
          ].join('\n'),
        );
        const sut = packedRefsWithout;

        // Act
        const result = sut(entries, new Set(['refs/heads/victim' as RefName]));

        // Assert
        expect(parsePackedRefs(result.content).entries).toEqual([
          { name: 'refs/heads/gone-object', id: SHA1 },
          { name: 'refs/tags/unpeeled', id: SHA2 },
        ]);
      });
    });
  });

  describe('Given the last remaining ref is removed', () => {
    describe('When packedRefsWithout runs', () => {
      it('Then the rewrite is exactly the 46-byte canonical header line and no entry survives', () => {
        // Arrange
        const entries: ReadonlyArray<PackedRefEntry> = [
          { name: 'refs/heads/main' as RefName, id: SHA1 },
        ];
        const sut = packedRefsWithout;

        // Act
        const result = sut(entries, new Set(['refs/heads/main' as RefName]));

        // Assert
        expect(result.content).toBe('# pack-refs with: peeled fully-peeled sorted \n');
        expect(new TextEncoder().encode(result.content)).toHaveLength(46);
        expect(result.entries).toEqual([]);
      });
    });
  });

  describe('Given a name that is not present in the entries', () => {
    describe('When packedRefsWithout runs', () => {
      it('Then it returns the canonical rewrite of every entry, unchanged in content', () => {
        // Arrange
        const entries: ReadonlyArray<PackedRefEntry> = [
          { name: 'refs/heads/main' as RefName, id: SHA1 },
          { name: 'refs/heads/other' as RefName, id: SHA2 },
        ];
        const sut = packedRefsWithout;

        // Act
        const result = sut(entries, new Set(['refs/heads/never-existed' as RefName]));

        // Assert
        expect(result.entries).toEqual(entries);
        expect(result.content).toBe(
          `# pack-refs with: peeled fully-peeled sorted \n${SHA1} refs/heads/main\n${SHA2} refs/heads/other\n`,
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
