import { describe, expect, it } from 'vitest';
import { renormalizeAttributeLookup } from '../../../../../src/application/primitives/internal/renormalize-attributes.js';
import type { FlatTree } from '../../../../../src/domain/diff/flat-tree.js';
import {
  FILE_MODE,
  type FilePath,
  type ObjectId,
} from '../../../../../src/domain/objects/index.js';

const ROOT = '.gitattributes' as FilePath;
const NESTED = 'sub/.gitattributes' as FilePath;
const id = (c: string): ObjectId => c.repeat(40) as ObjectId;

const treeOf = (files: Record<string, ObjectId>): FlatTree => ({
  entries: new Map(
    Object.entries(files).map(([path, oid]) => [
      path as FilePath,
      { id: oid, mode: FILE_MODE.REGULAR },
    ]),
  ),
});

describe('renormalizeAttributeLookup', () => {
  describe.each([
    ['added by one side only', undefined, treeOf({ '.gitattributes': id('a') }), treeOf({}), 'a'],
    [
      'unchanged by ours and edited by theirs',
      treeOf({ '.gitattributes': id('b') }),
      treeOf({ '.gitattributes': id('b') }),
      treeOf({ '.gitattributes': id('c') }),
      'c',
    ],
    [
      'edited by ours and unchanged by theirs',
      treeOf({ '.gitattributes': id('b') }),
      treeOf({ '.gitattributes': id('c') }),
      treeOf({ '.gitattributes': id('b') }),
      'c',
    ],
    [
      'edited identically by both sides',
      treeOf({ '.gitattributes': id('b') }),
      treeOf({ '.gitattributes': id('c') }),
      treeOf({ '.gitattributes': id('c') }),
      'c',
    ],
    [
      'edited by theirs and kept by ours with theirs equal to base',
      treeOf({ '.gitattributes': id('b') }),
      treeOf({ '.gitattributes': id('c') }),
      treeOf({ '.gitattributes': id('b') }),
      'c',
    ],
  ])('Given a root .gitattributes %s', (_label, base, ours, theirs, expected) => {
    describe('When the root file is looked up', () => {
      it('Then the side that settled it governs', () => {
        // Arrange
        const sut = renormalizeAttributeLookup(base, ours, theirs);

        // Act
        const result = sut(ROOT);

        // Assert
        expect(result).toBe(id(expected));
      });
    });
  });

  describe('Given theirs deleted a root .gitattributes that ours left as the base', () => {
    describe('When the root file is looked up', () => {
      it('Then no attributes govern', () => {
        // Arrange
        const base = treeOf({ '.gitattributes': id('b') });
        const sut = renormalizeAttributeLookup(base, base, treeOf({}));

        // Act
        const result = sut(ROOT);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a base text=auto with ours and theirs both editing it', () => {
    describe('When the root file is looked up', () => {
      it('Then the base governs', () => {
        // Arrange
        const sut = renormalizeAttributeLookup(
          treeOf({ '.gitattributes': id('b') }),
          treeOf({ '.gitattributes': id('o') }),
          treeOf({ '.gitattributes': id('t') }),
        );

        // Act
        const result = sut(ROOT);

        // Assert
        expect(result).toBe(id('b'));
      });
    });
  });

  describe('Given no base and both sides adding different .gitattributes', () => {
    describe('When the root file is looked up', () => {
      it('Then ours governs', () => {
        // Arrange
        const sut = renormalizeAttributeLookup(
          undefined,
          treeOf({ '.gitattributes': id('o') }),
          treeOf({ '.gitattributes': id('t') }),
        );

        // Act
        const result = sut(ROOT);

        // Assert
        expect(result).toBe(id('o'));
      });
    });
  });

  describe('Given a base without attributes, ours without them and theirs adding one', () => {
    describe('When the root file is looked up', () => {
      it('Then theirs governs', () => {
        // Arrange
        const sut = renormalizeAttributeLookup(
          treeOf({}),
          treeOf({}),
          treeOf({ '.gitattributes': id('t') }),
        );

        // Act
        const result = sut(ROOT);

        // Assert
        expect(result).toBe(id('t'));
      });
    });
  });

  describe('Given ours deleting the base file and theirs editing it', () => {
    describe('When the root file is looked up', () => {
      it('Then the base governs', () => {
        // Arrange
        const sut = renormalizeAttributeLookup(
          treeOf({ '.gitattributes': id('b') }),
          treeOf({}),
          treeOf({ '.gitattributes': id('t') }),
        );

        // Act
        const result = sut(ROOT);

        // Assert
        expect(result).toBe(id('b'));
      });
    });
  });

  describe('Given the same blob with different modes on the two sides', () => {
    describe('When the root file is looked up', () => {
      it('Then the sides count as different and the base governs', () => {
        // Arrange
        const entries = (mode: string) => ({
          entries: new Map([[ROOT, { id: id('a'), mode }]]),
        });
        const sut = renormalizeAttributeLookup(
          treeOf({ '.gitattributes': id('b') }),
          entries(FILE_MODE.REGULAR) as unknown as FlatTree,
          entries(FILE_MODE.EXECUTABLE) as unknown as FlatTree,
        );

        // Act
        const result = sut(ROOT);

        // Assert
        expect(result).toBe(id('b'));
      });
    });
  });

  describe('Given a nested .gitattributes on one side', () => {
    describe('When the nested file is looked up', () => {
      it('Then it is not consulted, as git conflicts instead of using it', () => {
        // Arrange
        const sut = renormalizeAttributeLookup(
          treeOf({}),
          treeOf({}),
          treeOf({ 'sub/.gitattributes': id('n') }),
        );

        // Act
        const result = sut(NESTED);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a root .gitattributes and a nested one', () => {
    describe('When the nested file is looked up', () => {
      it('Then it does not resolve to the root file', () => {
        // Arrange
        const sut = renormalizeAttributeLookup(
          undefined,
          treeOf({ '.gitattributes': id('a'), 'sub/.gitattributes': id('n') }),
          treeOf({}),
        );

        // Act
        const result = sut(NESTED);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given no trees at all', () => {
    describe('When the root file is looked up', () => {
      it('Then no attributes govern', () => {
        // Arrange
        const sut = renormalizeAttributeLookup(undefined, undefined, undefined);

        // Act
        const result = sut(ROOT);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });
});
