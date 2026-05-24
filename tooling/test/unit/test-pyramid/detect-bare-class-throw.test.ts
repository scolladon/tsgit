import { describe, expect, it } from 'vitest';
import { detectBareClassThrow } from '../../../test-pyramid/detect-bare-class-throw.js';
import { makeManifest } from './manifest-fixture.js';

const MANIFEST = makeManifest();
const file = (path: string, source: string) => ({ path, source });

describe('detectBareClassThrow', () => {
  it("Given `expect(fn).toThrow(TsgitError)`, When scanned, Then a finding with identifier='TsgitError'", () => {
    // Arrange
    const source = `\nit('Given x, When y, Then z', () => {\n  expect(fn).toThrow(TsgitError);\n});\n`;

    // Act
    const sut = detectBareClassThrow(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([
      {
        path: 'test/unit/a.test.ts',
        line: 2,
        title: 'Given x, When y, Then z',
        identifier: 'TsgitError',
      },
    ]);
  });

  it("Given `expect(fn).toThrowError(MyError)`, When scanned, Then a finding with identifier='MyError'", () => {
    // Arrange
    const source = `\nit('Given x, When y, Then z', () => {\n  expect(fn).toThrowError(MyError);\n});\n`;

    // Act
    const sut = detectBareClassThrow(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.identifier).toBe('MyError');
  });

  it("Given `expect(fn).toThrow('message')`, When scanned, Then no finding (string match is specific)", () => {
    // Arrange
    const source = `\nit('Given x, When y, Then z', () => { expect(fn).toThrow('boom'); });\n`;

    // Act
    const sut = detectBareClassThrow(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given `expect(fn).toThrow(/regex/)`, When scanned, Then no finding (regex match is specific)', () => {
    // Arrange
    const source = `\nit('Given x, When y, Then z', () => { expect(fn).toThrow(/boom/); });\n`;

    // Act
    const sut = detectBareClassThrow(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it("Given `expect(fn).toThrow(expect.objectContaining({ data: { code: 'X' } }))`, When scanned, Then no finding", () => {
    // Arrange
    const source = `\nit('Given x, When y, Then z', () => { expect(fn).toThrow(expect.objectContaining({ data: { code: 'X' } })); });\n`;

    // Act
    const sut = detectBareClassThrow(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given `expect(fn).toThrow(new Foo())`, When scanned, Then no finding (constructor invocation, not a bare class ref)', () => {
    // Arrange
    const source = `\nit('Given x, When y, Then z', () => { expect(fn).toThrow(new Foo()); });\n`;

    // Act
    const sut = detectBareClassThrow(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given `.toThrow(lowercase)` (a runtime value, not a class), When scanned, Then no finding', () => {
    // Arrange
    const source = `\nit('Given x, When y, Then z', () => { expect(fn).toThrow(expected); });\n`;

    // Act
    const sut = detectBareClassThrow(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given `.toThrow(Foo.message)`, When scanned, Then no finding (property access, not a bare class ref)', () => {
    // Arrange
    const source = `\nit('Given x, When y, Then z', () => { expect(fn).toThrow(Foo.message); });\n`;

    // Act
    const sut = detectBareClassThrow(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given an it.skip block with a bare-class toThrow, When scanned, Then no finding (skip exempt)', () => {
    // Arrange
    const source = `it.skip('Given x, When y, Then z', () => { expect(fn).toThrow(TsgitError); });`;

    // Act
    const sut = detectBareClassThrow(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given an integration test file with a bare-class toThrow, When scanned, Then no finding (heuristic scoped to unit)', () => {
    // Arrange
    const source = `it('whatever', () => { expect(fn).toThrow(TsgitError); });`;

    // Act
    const sut = detectBareClassThrow(MANIFEST, [file('test/integration/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given multiple files with findings, When scanned, Then they are sorted by path then by line', () => {
    // Arrange
    const sourceA = `\nit('Given a, When b, Then c', () => { expect(fn).toThrow(ErrA); });\n`;
    const sourceB = `\nit('Given d, When e, Then f', () => { expect(fn).toThrow(ErrB); });\nit('Given g, When h, Then i', () => { expect(fn).toThrow(ErrC); });\n`;

    // Act
    const sut = detectBareClassThrow(MANIFEST, [
      file('test/unit/b.test.ts', sourceB),
      file('test/unit/a.test.ts', sourceA),
    ]);

    // Assert
    expect(sut.map((f) => f.identifier)).toEqual(['ErrA', 'ErrB', 'ErrC']);
  });
});
