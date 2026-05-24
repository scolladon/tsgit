import { describe, expect, it } from 'vitest';
import { detectBadTitle } from '../../../test-pyramid/detect-bad-title.js';
import { makeManifest } from './manifest-fixture.js';

const MANIFEST = makeManifest();
const file = (path: string, source: string) => ({ path, source });
const at = (path: string, source: string) => detectBadTitle(MANIFEST, [file(path, source)]);

describe('Given a 3-level describe/describe/it tree', () => {
  describe('When the leaf is Then-only and ancestors are Given+When', () => {
    it('Then no finding is emitted', () => {
      // Arrange
      const source =
        `describe('Given a sut', () => {\n` +
        `  describe('When op runs', () => {\n` +
        `    it('Then it returns x', () => { expect(1).toBe(1); });\n` +
        `  });\n` +
        `});`;

      // Act
      const sut = at('test/unit/a.test.ts', source);

      // Assert
      expect(sut).toEqual([]);
    });
  });
});

describe('Given a 2-level describe with combined Given+When', () => {
  describe('When the leaf is Then-only', () => {
    it('Then no finding is emitted', () => {
      // Arrange
      const source =
        `describe('Given a sut, When op runs', () => {\n` +
        `  it('Then it returns x', () => { expect(1).toBe(1); });\n` +
        `});`;

      // Act
      const sut = at('test/unit/a.test.ts', source);

      // Assert
      expect(sut).toEqual([]);
    });
  });
});

describe('Given an outer non-GWT describe wrapping a 3-level GWT group', () => {
  describe('When the audit runs', () => {
    it('Then the non-GWT describe is transparent and no finding is emitted', () => {
      // Arrange
      const source =
        `describe('moduleName', () => {\n` +
        `  describe('Given a sut', () => {\n` +
        `    describe('When op runs', () => {\n` +
        `      it('Then it returns x', () => { expect(1).toBe(1); });\n` +
        `    });\n` +
        `  });\n` +
        `});`;

      // Act
      const sut = at('test/unit/a.test.ts', source);

      // Assert
      expect(sut).toEqual([]);
    });
  });
});

describe('Given an it() with no literal title', () => {
  describe('When scanned', () => {
    it('Then the block is dropped by scanItBlocks and produces no finding', () => {
      // Arrange — `it(() => {…})` has no title; scanner skips it.
      const source = `it(() => { expect(1).toBe(1); });`;

      // Act
      const sut = at('test/unit/a.test.ts', source);

      // Assert
      expect(sut).toEqual([]);
    });
  });
});

describe("Given an it() with an empty title ''", () => {
  describe('When scanned', () => {
    it('Then a missing finding is emitted', () => {
      // Arrange
      const source = `it('', () => { expect(1).toBe(1); });`;

      // Act
      const sut = at('test/unit/a.test.ts', source);

      // Assert
      expect(sut).toEqual([
        {
          path: 'test/unit/a.test.ts',
          line: 1,
          title: '<missing>',
          ancestors: [],
          reason: 'missing',
        },
      ]);
    });
  });
});

describe('Given a Then-only leaf with no GWT ancestor', () => {
  describe('When scanned', () => {
    it('Then a when-missing finding is emitted', () => {
      // Arrange
      const source = `it('Then it returns x', () => { expect(1).toBe(1); });`;

      // Act
      const sut = at('test/unit/a.test.ts', source);

      // Assert
      expect(sut).toHaveLength(1);
      expect(sut[0]?.reason).toBe('when-missing');
    });
  });
});

describe('Given a Then-only leaf under describe("When ...") only', () => {
  describe('When scanned', () => {
    it('Then a given-missing finding is emitted', () => {
      // Arrange
      const source =
        `describe('When op runs', () => {\n` +
        `  it('Then it returns x', () => { expect(1).toBe(1); });\n` +
        `});`;

      // Act
      const sut = at('test/unit/a.test.ts', source);

      // Assert
      expect(sut).toHaveLength(1);
      expect(sut[0]?.reason).toBe('given-missing');
    });
  });
});

describe('Given a Then-only leaf under describe("Given ...") only', () => {
  describe('When scanned', () => {
    it('Then a when-missing finding is emitted', () => {
      // Arrange
      const source =
        `describe('Given a sut', () => {\n` +
        `  it('Then it returns x', () => { expect(1).toBe(1); });\n` +
        `});`;

      // Act
      const sut = at('test/unit/a.test.ts', source);

      // Assert
      expect(sut).toHaveLength(1);
      expect(sut[0]?.reason).toBe('when-missing');
    });
  });
});

describe('Given a reversed-nesting describe("When") > describe("Given") > it("Then")', () => {
  describe('When scanned', () => {
    it('Then a nested-gwt finding is emitted', () => {
      // Arrange — closest ancestor is Given, outer is When; rule wants the inverse.
      const source =
        `describe('When op runs', () => {\n` +
        `  describe('Given a sut', () => {\n` +
        `    it('Then it returns x', () => { expect(1).toBe(1); });\n` +
        `  });\n` +
        `});`;

      // Act
      const sut = at('test/unit/a.test.ts', source);

      // Assert
      expect(sut).toHaveLength(1);
      expect(sut[0]?.reason).toBe('nested-gwt');
    });
  });
});

describe('Given a triple-nested GWT path with a duplicated clause', () => {
  describe('When scanned', () => {
    it('Then a nested-gwt finding is emitted', () => {
      // Arrange — two Givens stacked.
      const source =
        `describe('Given a parent', () => {\n` +
        `  describe('Given a sut', () => {\n` +
        `    describe('When op runs', () => {\n` +
        `      it('Then it returns x', () => { expect(1).toBe(1); });\n` +
        `    });\n` +
        `  });\n` +
        `});`;

      // Act
      const sut = at('test/unit/a.test.ts', source);

      // Assert
      expect(sut).toHaveLength(1);
      expect(sut[0]?.reason).toBe('nested-gwt');
    });
  });
});

describe('Given a legacy it("Given X, When Y, Then Z") leaf', () => {
  describe('When scanned', () => {
    it('Then a legacy-it-gwt finding is emitted (no ancestors needed)', () => {
      // Arrange
      const source = `it('Given a, When b, Then c', () => { expect(1).toBe(1); });`;

      // Act
      const sut = at('test/unit/a.test.ts', source);

      // Assert
      expect(sut).toHaveLength(1);
      expect(sut[0]?.reason).toBe('legacy-it-gwt');
      expect(sut[0]?.ancestors).toEqual([]);
    });
  });
});

describe('Given a non-GWT it("does X") leaf', () => {
  describe('When scanned', () => {
    it('Then a then-missing finding is emitted', () => {
      // Arrange
      const source = `it('does something', () => { expect(1).toBe(1); });`;

      // Act
      const sut = at('test/unit/a.test.ts', source);

      // Assert
      expect(sut).toHaveLength(1);
      expect(sut[0]?.reason).toBe('then-missing');
    });
  });
});

describe('Given a .skip leaf with a non-GWT title', () => {
  describe('When scanned', () => {
    it('Then the skipped block is still validated and a finding is emitted', () => {
      // Arrange
      const source = `it.skip('TODO', () => {});`;

      // Act
      const sut = at('test/unit/a.test.ts', source);

      // Assert
      expect(sut).toHaveLength(1);
      expect(sut[0]?.reason).toBe('then-missing');
    });
  });
});

describe('Given an integration test file with a non-GWT leaf', () => {
  describe('When scanned', () => {
    it('Then no finding is emitted (heuristic is scoped to the unit tier)', () => {
      // Arrange
      const source = `it('plain title', () => { expect(1).toBe(1); });`;

      // Act
      const sut = at('test/integration/a.test.ts', source);

      // Assert
      expect(sut).toEqual([]);
    });
  });
});

describe('Given multiple files with findings', () => {
  describe('When scanned together', () => {
    it('Then findings are sorted by path and then by line', () => {
      // Arrange
      const sourceA = `it('plain', () => { expect(1).toBe(1); });`;
      const sourceB =
        `it('Then x', () => { expect(1).toBe(1); });\n` +
        `it('Given a, When b, Then c', () => { expect(1).toBe(1); });`;

      // Act
      const sut = detectBadTitle(MANIFEST, [
        file('test/unit/b.test.ts', sourceB),
        file('test/unit/a.test.ts', sourceA),
      ]);

      // Assert
      expect(sut.map((f) => f.path)).toEqual([
        'test/unit/a.test.ts',
        'test/unit/b.test.ts',
        'test/unit/b.test.ts',
      ]);
      expect(sut[2]?.line).toBeGreaterThan(sut[1]?.line ?? 0);
    });
  });
});

describe('Given an empty list of files', () => {
  describe('When scanned', () => {
    it('Then an empty array is returned', () => {
      // Arrange + Act
      const sut = detectBadTitle(MANIFEST, []);

      // Assert
      expect(sut).toEqual([]);
    });
  });
});
