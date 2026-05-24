import { describe, expect, it } from 'vitest';
import { rewriteSource } from '../../codemod-gwt-describe-split.js';

describe('Given a file with sibling legacy it() titles sharing Given+When', () => {
  describe('When rewriteSource runs', () => {
    it('Then the leaves are grouped under a single 3-level describe', () => {
      // Arrange
      const source =
        `import { describe, expect, it } from 'vitest';\n` +
        `\n` +
        `it('Given a sut, When op runs, Then result is x', () => { expect(1).toBe(1); });\n` +
        `it('Given a sut, When op runs, Then it returns y', () => { expect(2).toBe(2); });\n`;

      // Act
      const sut = rewriteSource(source);

      // Assert
      expect(sut).toContain("describe('Given a sut', () => {");
      expect(sut).toContain("describe('When op runs', () => {");
      expect(sut).toContain("it('Then result is x',");
      expect(sut).toContain("it('Then it returns y',");
      // Both leaves under one Given>When.
      expect(sut.match(/describe\('Given a sut'/g)?.length).toBe(1);
      expect(sut.match(/describe\('When op runs'/g)?.length).toBe(1);
    });
  });
});

describe('Given a file with a single legacy it()', () => {
  describe('When rewriteSource runs', () => {
    it('Then a 3-level describe is still emitted (codemod never produces 2-level)', () => {
      // Arrange
      const source =
        `import { it, expect } from 'vitest';\n\n` +
        `it('Given X, When Y, Then Z', () => { expect(1).toBe(1); });\n`;

      // Act
      const sut = rewriteSource(source);

      // Assert
      expect(sut).toContain("describe('Given X', () => {");
      expect(sut).toContain("describe('When Y', () => {");
      expect(sut).toContain("it('Then Z',");
    });
  });
});

describe('Given a file already using the new describe/it layout', () => {
  describe('When rewriteSource runs', () => {
    it('Then the file is returned unchanged', () => {
      // Arrange
      const source =
        `describe('Given a sut', () => {\n` +
        `  describe('When op runs', () => {\n` +
        `    it('Then result is x', () => { expect(1).toBe(1); });\n` +
        `  });\n` +
        `});\n`;

      // Act
      const sut = rewriteSource(source);

      // Assert
      expect(sut).toBe(source);
    });
  });
});

describe('Given a file with legacy it() leaves nested inside a module describe', () => {
  describe('When rewriteSource runs', () => {
    it('Then the module describe is preserved and inner leaves are grouped', () => {
      // Arrange
      const source =
        `describe('moduleName', () => {\n` +
        `  it('Given a, When b, Then c', () => { expect(1).toBe(1); });\n` +
        `  it('Given a, When b, Then d', () => { expect(2).toBe(2); });\n` +
        `});\n`;

      // Act
      const sut = rewriteSource(source);

      // Assert
      expect(sut).toContain("describe('moduleName', () => {");
      expect(sut).toContain("describe('Given a', () => {");
      expect(sut).toContain("describe('When b', () => {");
      expect(sut).toContain("it('Then c',");
      expect(sut).toContain("it('Then d',");
    });
  });
});

describe('Given a file with non-rewritable shapes', () => {
  describe('When rewriteSource runs', () => {
    it('Then unknown shapes pass through unchanged', () => {
      // Arrange — title is a template literal, codemod skips it.
      const source =
        `it(\`Given \${x}, When y, Then z\`, () => { expect(1).toBe(1); });\n`;

      // Act
      const sut = rewriteSource(source);

      // Assert
      expect(sut).toBe(source);
    });
  });
});

describe('Given a file with leaves under different (Given, When) pairs', () => {
  describe('When rewriteSource runs', () => {
    it('Then each pair gets its own 3-level describe group', () => {
      // Arrange
      const source =
        `it('Given a, When op1, Then x', () => { expect(1).toBe(1); });\n` +
        `it('Given a, When op2, Then y', () => { expect(2).toBe(2); });\n` +
        `it('Given b, When op1, Then z', () => { expect(3).toBe(3); });\n`;

      // Act
      const sut = rewriteSource(source);

      // Assert
      expect(sut.match(/describe\('Given a'/g)?.length).toBe(1);
      expect(sut.match(/describe\('Given b'/g)?.length).toBe(1);
      expect(sut.match(/describe\('When op1'/g)?.length).toBe(2);
      expect(sut.match(/describe\('When op2'/g)?.length).toBe(1);
    });
  });
});

describe('Given an empty source', () => {
  describe('When rewriteSource runs', () => {
    it('Then the empty source is returned', () => {
      // Arrange + Act
      const sut = rewriteSource('');

      // Assert
      expect(sut).toBe('');
    });
  });
});
