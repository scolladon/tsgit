import { describe, expect, it } from 'vitest';
import { scanDescribeBlocks } from '../../../test-pyramid/scan-describe-blocks.js';

describe('Given an empty source', () => {
  describe('When scanDescribeBlocks runs', () => {
    it('Then it returns an empty array', () => {
      // Arrange
      const source = '';

      // Act
      const sut = scanDescribeBlocks(source);

      // Assert
      expect(sut).toEqual([]);
    });
  });
});

describe('Given a single top-level describe() block', () => {
  describe('When scanDescribeBlocks runs', () => {
    it('Then one record with line/title/openIdx/closeIdx is returned', () => {
      // Arrange
      const source = `\ndescribe('Given a thing', () => { /* body */ });\n`;

      // Act
      const sut = scanDescribeBlocks(source);

      // Assert
      expect(sut).toHaveLength(1);
      expect(sut[0]).toMatchObject({ line: 2, title: 'Given a thing', isSkipped: false });
      expect(sut[0]?.openIdx).toBeGreaterThan(0);
      expect(sut[0]?.closeIdx).toBeGreaterThan(sut[0]?.openIdx ?? 0);
    });
  });
});

describe('Given two nested describe() blocks', () => {
  describe('When scanDescribeBlocks runs', () => {
    it('Then both records are returned and the inner spans are contained by the outer span', () => {
      // Arrange
      const source = `describe('outer', () => {\n  describe('inner', () => {});\n});`;

      // Act
      const sut = scanDescribeBlocks(source);

      // Assert
      expect(sut.map((b) => b.title)).toEqual(['outer', 'inner']);
      const outer = sut[0]!;
      const inner = sut[1]!;
      expect(inner.openIdx).toBeGreaterThan(outer.openIdx);
      expect(inner.closeIdx).toBeLessThan(outer.closeIdx);
    });
  });
});

describe('Given a describe.skip() block', () => {
  describe('When scanDescribeBlocks runs', () => {
    it('Then isSkipped is true', () => {
      // Arrange
      const source = `describe.skip('skipped group', () => {});`;

      // Act
      const sut = scanDescribeBlocks(source);

      // Assert
      expect(sut).toHaveLength(1);
      expect(sut[0]?.isSkipped).toBe(true);
    });
  });
});

describe('Given a describe.todo() block without body', () => {
  describe('When scanDescribeBlocks runs', () => {
    it('Then isSkipped is true', () => {
      // Arrange
      const source = `describe.todo('later');`;

      // Act
      const sut = scanDescribeBlocks(source);

      // Assert
      expect(sut).toHaveLength(1);
      expect(sut[0]?.isSkipped).toBe(true);
    });
  });
});

describe('Given a describe.each([...])("title", body) block', () => {
  describe('When scanDescribeBlocks runs', () => {
    it('Then the inner title is extracted', () => {
      // Arrange
      const source = `describe.each([1, 2])('case %s', (n) => { it('Then x', () => {}); });`;

      // Act
      const sut = scanDescribeBlocks(source);

      // Assert
      expect(sut).toHaveLength(1);
      expect(sut[0]?.title).toBe('case %s');
    });
  });
});

describe('Given a describe.each() with a nested describe inside its body', () => {
  describe('When scanDescribeBlocks runs', () => {
    it('Then the nested describe is captured (each-body is walked, not skipped)', () => {
      // Arrange
      const source =
        `describe.each([1, 2])('outer %s', () => { describe('inner', () => {}); });`;

      // Act
      const sut = scanDescribeBlocks(source);

      // Assert
      expect(sut.map((b) => b.title)).toEqual(['outer %s', 'inner']);
    });
  });
});

describe('Given a describe() with no title literal (arrow-only)', () => {
  describe('When scanDescribeBlocks runs', () => {
    it('Then the block is dropped', () => {
      // Arrange
      const source = `describe(() => { it('Then x', () => {}); });`;

      // Act
      const sut = scanDescribeBlocks(source);

      // Assert
      expect(sut).toEqual([]);
    });
  });
});

describe('Given a describe() with a backtick title', () => {
  describe('When scanDescribeBlocks runs', () => {
    it('Then the literal is extracted', () => {
      // Arrange
      const source = `describe(\`tick\`, () => {});`;

      // Act
      const sut = scanDescribeBlocks(source);

      // Assert
      expect(sut[0]?.title).toBe('tick');
    });
  });
});

describe('Given a describe() whose body never closes', () => {
  describe('When scanDescribeBlocks runs', () => {
    it('Then the block is dropped silently', () => {
      // Arrange
      const source = `describe('unbalanced', () => {`;

      // Act
      const sut = scanDescribeBlocks(source);

      // Assert
      expect(sut).toEqual([]);
    });
  });
});

describe('Given an it() with a body that calls compiled.describe()', () => {
  describe('When scanDescribeBlocks runs', () => {
    it('Then the method-call site is not mistaken for a describe opener', () => {
      // Arrange — `.describe(` should be filtered by the (?<!\.) lookbehind.
      const source = `describe('outer', () => { compiled.describe('skip me'); });`;

      // Act
      const sut = scanDescribeBlocks(source);

      // Assert
      expect(sut).toHaveLength(1);
      expect(sut[0]?.title).toBe('outer');
    });
  });
});

describe('Given two sibling describe blocks at top level', () => {
  describe('When scanDescribeBlocks runs', () => {
    it('Then both are returned in source order', () => {
      // Arrange
      const source = `\ndescribe('first', () => {});\ndescribe('second', () => {});\n`;

      // Act
      const sut = scanDescribeBlocks(source);

      // Assert
      expect(sut.map((b) => b.title)).toEqual(['first', 'second']);
    });
  });
});

describe('Given a describe.skipIf(cond)("title", body) block', () => {
  describe('When scanDescribeBlocks runs', () => {
    it('Then the inner title is extracted and isSkipped is false', () => {
      // Arrange — conditional-skip helpers wrap the title in a second call;
      // the scanner treats them as two-stage like `describe.each([…])(…)`.
      const source = `describe.skipIf(process.env.CI)('Given x', () => { it('Then y', () => {}); });`;

      // Act
      const sut = scanDescribeBlocks(source);

      // Assert
      expect(sut.map((b) => b.title)).toEqual(['Given x']);
      expect(sut[0]?.isSkipped).toBe(false);
    });
  });
});

describe('Given a describe.runIf(cond)("title", body) block', () => {
  describe('When scanDescribeBlocks runs', () => {
    it('Then the inner title is extracted and isSkipped is false', () => {
      // Arrange
      const source = `describe.runIf(process.env.CI)('Given y', () => { it('Then z', () => {}); });`;

      // Act
      const sut = scanDescribeBlocks(source);

      // Assert
      expect(sut.map((b) => b.title)).toEqual(['Given y']);
      expect(sut[0]?.isSkipped).toBe(false);
    });
  });
});

describe('Given a describe.skipIf(cond) followed by no inner call', () => {
  describe('When scanDescribeBlocks runs', () => {
    it('Then the block is dropped silently', () => {
      // Arrange — invalid in vitest, but the scanner must not crash and must
      // still emit the well-formed sibling block.
      const source = `\ndescribe.skipIf(true);\ndescribe('valid', () => {});\n`;

      // Act
      const sut = scanDescribeBlocks(source);

      // Assert
      expect(sut.map((b) => b.title)).toEqual(['valid']);
    });
  });
});

describe('Given a describe.runIf(cond)("title", body) whose inner call never closes', () => {
  describe('When scanDescribeBlocks runs', () => {
    it('Then the block is dropped silently', () => {
      // Arrange
      const source = `describe.runIf(true)('Given x', () => { it('Then y',`;

      // Act
      const sut = scanDescribeBlocks(source);

      // Assert
      expect(sut).toEqual([]);
    });
  });
});

describe('Given a describe.skipIf(cond)("outer", body) wrapping an inner describe', () => {
  describe('When scanDescribeBlocks runs', () => {
    it('Then both records are returned and the inner span is contained by the outer span', () => {
      // Arrange
      const source = `describe.skipIf(false)('outer', () => { describe('inner', () => {}); });`;

      // Act
      const sut = scanDescribeBlocks(source);

      // Assert
      expect(sut.map((b) => b.title)).toEqual(['outer', 'inner']);
      const outer = sut[0]!;
      const inner = sut[1]!;
      expect(inner.openIdx).toBeGreaterThan(outer.openIdx);
      expect(inner.closeIdx).toBeLessThan(outer.closeIdx);
    });
  });
});
