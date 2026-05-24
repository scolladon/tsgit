import { describe, expect, it } from 'vitest';
import { detectMissingAaa } from '../../../../scripts/test-pyramid/detect-missing-aaa.js';
import { makeManifest } from './manifest-fixture.js';

const MANIFEST = makeManifest();
const file = (path: string, source: string) => ({ path, source });

describe('detectMissingAaa', () => {
  it('Given a unit it() with // Arrange and // Assert markers, When scanned, Then no finding', () => {
    // Arrange
    const source = `\nit('Given x, When y, Then z', () => {\n  // Arrange\n  const x = 1;\n  // Assert\n  expect(x).toBe(1);\n});\n`;

    // Act
    const sut = detectMissingAaa(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given a unit it() with only // Arrange, When scanned, Then missing names Assert', () => {
    // Arrange
    const source = `\nit('Given x, When y, Then z', () => {\n  // Arrange\n  expect(1).toBe(1);\n});\n`;

    // Act
    const sut = detectMissingAaa(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.missing).toEqual(['Assert']);
  });

  it('Given a unit it() with only // Assert, When scanned, Then missing names Arrange', () => {
    // Arrange
    const source = `\nit('Given x, When y, Then z', () => {\n  // Assert\n  expect(1).toBe(1);\n});\n`;

    // Act
    const sut = detectMissingAaa(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.missing).toEqual(['Arrange']);
  });

  it('Given a unit it() with neither marker, When scanned, Then missing names both', () => {
    // Arrange
    const source = `\nit('Given x, When y, Then z', () => {\n  expect(1).toBe(1);\n});\n`;

    // Act
    const sut = detectMissingAaa(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.missing).toEqual(['Arrange', 'Assert']);
  });

  it('Given a marker with trailing prose (// Assert — covers all three), When scanned, Then no finding', () => {
    // Arrange
    const source = `\nit('Given x, When y, Then z', () => {\n  // Arrange\n  const x = 1;\n  // Assert — covers all three reporter methods.\n  expect(x).toBe(1);\n});\n`;

    // Act
    const sut = detectMissingAaa(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given a compound word // Assertion in place of // Assert, When scanned, Then a finding (\\b boundary)', () => {
    // Arrange
    const source = `\nit('Given x, When y, Then z', () => {\n  // Arrange\n  // Assertion\n  expect(1).toBe(1);\n});\n`;

    // Act
    const sut = detectMissingAaa(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.missing).toEqual(['Assert']);
  });

  it('Given a lowercase // arrange marker, When scanned, Then a finding (case-sensitive)', () => {
    // Arrange
    const source = `\nit('Given x, When y, Then z', () => {\n  // arrange\n  // Assert\n  expect(1).toBe(1);\n});\n`;

    // Act
    const sut = detectMissingAaa(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.missing).toEqual(['Arrange']);
  });

  it('Given an inline mid-line // Assert comment, When scanned, Then it is not honoured (line-anchored)', () => {
    // Arrange — marker is not at the start of a line.
    const source = `\nit('Given x, When y, Then z', () => {\n  expect(1).toBe(1); // Assert\n});\n`;

    // Act
    const sut = detectMissingAaa(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert — Arrange + Assert both missing.
    expect(sut).toHaveLength(1);
    expect(sut[0]?.missing).toEqual(['Arrange', 'Assert']);
  });

  it('Given an it.skip block with no markers, When scanned, Then no finding (skip exempt)', () => {
    // Arrange
    const source = `\nit.skip('Given x, When y, Then z', () => { /* later */ });\n`;

    // Act
    const sut = detectMissingAaa(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given an integration file with no markers, When scanned, Then no finding (heuristic scoped to unit)', () => {
    // Arrange
    const source = `it('whatever', () => { expect(1).toBe(1); });`;

    // Act
    const sut = detectMissingAaa(MANIFEST, [file('test/integration/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given a stricter manifest requiring Arrange + Act + Assert, When only Arrange + Assert are present, Then Act is reported missing', () => {
    // Arrange
    const stricter = makeManifest({ aaaRequired: ['Arrange', 'Act', 'Assert'] });
    const source = `\nit('Given x, When y, Then z', () => {\n  // Arrange\n  const x = 1;\n  // Assert\n  expect(x).toBe(1);\n});\n`;

    // Act
    const sut = detectMissingAaa(stricter, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.missing).toEqual(['Act']);
  });

  it('Given marker indentation with spaces and tabs, When scanned, Then both forms are honoured', () => {
    // Arrange
    const source = `\nit('Given x, When y, Then z', () => {\n  // Arrange\n\t\t// Assert\n  expect(1).toBe(1);\n});\n`;

    // Act
    const sut = detectMissingAaa(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given multiple files with findings, When scanned, Then they are sorted by path then by line', () => {
    // Arrange
    const sourceA = `\nit('Given a, When b, Then c', () => { expect(1).toBe(1); });\n`;
    const sourceB = `\nit('Given a, When b, Then c', () => { expect(1).toBe(1); });\nit('Given d, When e, Then f', () => { expect(2).toBe(2); });\n`;

    // Act
    const sut = detectMissingAaa(MANIFEST, [
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
