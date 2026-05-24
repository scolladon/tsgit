import { describe, expect, it } from 'vitest';
import { detectBadTitle } from '../../../../scripts/test-pyramid/detect-bad-title.js';
import { makeManifest } from './manifest-fixture.js';

const MANIFEST = makeManifest();
const file = (path: string, source: string) => ({ path, source });

describe('detectBadTitle', () => {
  it('Given a unit it() with a GWT title, When scanned, Then no finding', () => {
    // Arrange
    const source = `\nit('Given x, When y, Then z', () => { expect(1).toBe(1); });\n`;

    // Act
    const sut = detectBadTitle(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given a unit it() with a title missing "When", When scanned, Then a malformed finding', () => {
    // Arrange
    const source = `\nit('Given a state, Then it works', () => { expect(1).toBe(1); });\n`;

    // Act
    const sut = detectBadTitle(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([
      {
        path: 'test/unit/a.test.ts',
        line: 2,
        title: 'Given a state, Then it works',
        reason: 'malformed',
      },
    ]);
  });

  it('Given a unit it() with a title missing "Then", When scanned, Then a malformed finding', () => {
    // Arrange
    const source = `\nit('Given x, When y', () => { expect(1).toBe(1); });\n`;

    // Act
    const sut = detectBadTitle(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.reason).toBe('malformed');
  });

  it('Given a unit it() with a lowercase "given" prefix, When scanned, Then a malformed finding (case-sensitive)', () => {
    // Arrange
    const source = `\nit('given x, when y, then z', () => { expect(1).toBe(1); });\n`;

    // Act
    const sut = detectBadTitle(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.reason).toBe('malformed');
  });

  it('Given a unit it() without a literal title (arrow-only), When scanned, Then no finding (block dropped by scanner)', () => {
    // Arrange — title-less openers are dropped by scanItBlocks itself; the
    // detector never sees them. Documented behaviour.
    const source = `\nit(() => { expect(1).toBe(1); });\n`;

    // Act
    const sut = detectBadTitle(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it("Given a unit it() with an empty title string '', When scanned, Then a missing finding is emitted", () => {
    // Arrange
    const source = `\nit('', () => { expect(1).toBe(1); });\n`;

    // Act
    const sut = detectBadTitle(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([
      { path: 'test/unit/a.test.ts', line: 2, title: '<missing>', reason: 'missing' },
    ]);
  });

  it('Given an it.each([...])(template, body), When the template matches GWT, Then no finding', () => {
    // Arrange
    const source = `it.each([1])('Given n=%s, When called, Then ok', (n) => { expect(n).toBe(1); });`;

    // Act
    const sut = detectBadTitle(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given an it.skip block with a non-GWT title, When scanned, Then a malformed finding (skip is still validated)', () => {
    // Arrange
    const source = `it.skip('TODO', () => {});`;

    // Act
    const sut = detectBadTitle(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.reason).toBe('malformed');
    expect(sut[0]?.title).toBe('TODO');
  });

  it('Given an integration test file with a non-GWT title, When scanned, Then no finding (heuristic scoped to unit)', () => {
    // Arrange
    const source = `it('no GWT here', () => { expect(1).toBe(1); });`;

    // Act
    const sut = detectBadTitle(MANIFEST, [file('test/integration/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given a multi-line opener with a malformed title on the second line, When scanned, Then one malformed finding is emitted', () => {
    // Arrange
    const source = `\nit(\n  'plain old title',\n  () => { expect(1).toBe(1); },\n);\n`;

    // Act
    const sut = detectBadTitle(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.line).toBe(2);
    expect(sut[0]?.title).toBe('plain old title');
  });

  it('Given multiple files with findings, When scanned, Then findings are sorted by path then by line', () => {
    // Arrange
    const sourceA = `it('bad', () => { expect(1).toBe(1); });`;
    const sourceB = `it('also bad', () => { expect(1).toBe(1); });\nit('Given a, When b, Then c', () => { expect(1).toBe(1); });\nit('third bad', () => { expect(1).toBe(1); });`;

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

  it('Given an empty list of files, When scanned, Then an empty array is returned', () => {
    // Arrange + Act
    const sut = detectBadTitle(MANIFEST, []);

    // Assert
    expect(sut).toEqual([]);
  });
});
