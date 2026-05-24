import { describe, expect, it } from 'vitest';
import { scanItBlocks } from '../../../test-pyramid/scan-it-blocks.js';

describe('scanItBlocks', () => {
  it('Given an empty source, When scanned, Then an empty array is returned', () => {
    // Arrange
    const source = '';

    // Act
    const sut = scanItBlocks(source);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given a single it() block, When scanned, Then one block with line/title/body/isSkipped is returned', () => {
    // Arrange
    const source = `\nit('only one', () => { /* body */ });\n`;

    // Act
    const sut = scanItBlocks(source);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]).toMatchObject({ line: 2, title: 'only one', isSkipped: false });
    expect(sut[0]?.body).toContain('/* body */');
  });

  it('Given an it.skip block, When scanned, Then isSkipped is true', () => {
    // Arrange
    const source = `it.skip('skipped', () => {});`;

    // Act
    const sut = scanItBlocks(source);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.isSkipped).toBe(true);
  });

  it('Given an it.todo block without body, When scanned, Then isSkipped is true', () => {
    // Arrange
    const source = `it.todo('later');`;

    // Act
    const sut = scanItBlocks(source);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.isSkipped).toBe(true);
  });

  it('Given an it.fails block, When scanned, Then isSkipped is true', () => {
    // Arrange
    const source = `it.fails('expected fail', () => { throw new Error('x'); });`;

    // Act
    const sut = scanItBlocks(source);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.isSkipped).toBe(true);
  });

  it("Given an it.each([…])('title', body), When scanned, Then the inner title is extracted", () => {
    // Arrange
    const source = `it.each([1, 2, 3])('case %s', (n) => { expect(n).toBeGreaterThan(0); });`;

    // Act
    const sut = scanItBlocks(source);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.title).toBe('case %s');
    expect(sut[0]?.body).toContain('expect(n)');
  });

  it('Given a test() alias, When scanned, Then the block is returned just like it()', () => {
    // Arrange
    const source = `test('alias block', () => { expect(true).toBe(true); });`;

    // Act
    const sut = scanItBlocks(source);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.title).toBe('alias block');
  });

  it('Given a method call ending in .test(), When scanned, Then it is not mistaken for a vitest opener', () => {
    // Arrange — only the outer it() block should be returned.
    const source = `\nit('regex check', () => { compiled.test('lib/foo.ts'); });\n`;

    // Act
    const sut = scanItBlocks(source);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.title).toBe('regex check');
  });

  it('Given a backtick-quoted title, When scanned, Then the literal is extracted', () => {
    // Arrange
    const source = `it(\`backtick title\`, () => {});`;

    // Act
    const sut = scanItBlocks(source);

    // Assert
    expect(sut[0]?.title).toBe('backtick title');
  });

  it('Given a title with an escaped quote, When scanned, Then the escape is preserved verbatim', () => {
    // Arrange — backslash-quote should not terminate the literal scan.
    const source = `it('contains \\'quote\\'', () => { expect(1).toBe(1); });`;

    // Act
    const sut = scanItBlocks(source);

    // Assert
    expect(sut[0]?.title).toBe("contains \\'quote\\'");
  });

  it('Given a multi-line opener (it on one line, title on next), When scanned, Then the block is still extracted', () => {
    // Arrange
    const source = `\nit(\n  'multi line title',\n  () => { expect(1).toBe(1); },\n);\n`;

    // Act
    const sut = scanItBlocks(source);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.title).toBe('multi line title');
    expect(sut[0]?.line).toBe(2);
  });

  it('Given an it() with no title literal (arrow-only call), When scanned, Then the block is dropped', () => {
    // Arrange — `it(() => {…})` has no string title; the scanner skips it.
    const source = `it(() => { expect(1).toBe(1); });`;

    // Act
    const sut = scanItBlocks(source);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given an it.each(...) followed by no inner call, When scanned, Then the block is dropped silently', () => {
    // Arrange — invalid in vitest, but scanner must not crash.
    const source = `\nit.each([1, 2, 3]);\nit('valid', () => { expect(1).toBe(1); });\n`;

    // Act
    const sut = scanItBlocks(source);

    // Assert — only the well-formed it() is returned.
    expect(sut).toHaveLength(1);
    expect(sut[0]?.title).toBe('valid');
  });

  it('Given an it.each(...) whose inner call never closes, When scanned, Then the block is dropped silently', () => {
    // Arrange
    const source = `it.each([1, 2])('case %s', (n) => { expect(n).toBeGreaterThan(0);`;

    // Act
    const sut = scanItBlocks(source);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given two top-level it() blocks, When scanned, Then both are returned in source order', () => {
    // Arrange
    const source = `\nit('first', () => { expect(1).toBe(1); });\nit('second', () => { expect(2).toBe(2); });\n`;

    // Act
    const sut = scanItBlocks(source);

    // Assert
    expect(sut.map((b) => b.title)).toEqual(['first', 'second']);
    expect(sut[1]?.line).toBeGreaterThan(sut[0]?.line ?? 0);
  });

  it("Given a body containing a nested describe('…', () => {}), When scanned, Then only the outer it() is returned", () => {
    // Arrange — the scanner does not enter nested describes; the outer it()'s
    // brace counter passes through them.
    const source = `\nit('outer', () => {\n  describe('inner', () => {});\n  expect(1).toBe(1);\n});\n`;

    // Act
    const sut = scanItBlocks(source);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.title).toBe('outer');
  });

  it('Given an opener whose body opens but never closes, When scanned, Then the block is dropped silently', () => {
    // Arrange — closing `)` is missing.
    const source = `it('unbalanced', () => { expect(1).toBe(1);`;

    // Act
    const sut = scanItBlocks(source);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given a string-literal opener with no closing quote, When scanned, Then the block is dropped silently', () => {
    // Arrange
    const source = `it('unterminated title`;

    // Act
    const sut = scanItBlocks(source);

    // Assert
    expect(sut).toEqual([]);
  });
});
