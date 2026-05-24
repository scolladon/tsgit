import { describe, expect, it } from 'vitest';
import { detectBannedSutName } from '../../../test-pyramid/detect-banned-sut-name.js';
import { makeManifest } from './manifest-fixture.js';

const MANIFEST = makeManifest();
const file = (path: string, source: string) => ({ path, source });

describe('detectBannedSutName', () => {
  it('Given a unit it() with `const sut = …`, When scanned, Then no finding', () => {
    // Arrange
    const source = `\nit('Given x, When y, Then z', () => {\n  // Arrange\n  const sut = build();\n  // Assert\n  expect(sut).toBeDefined();\n});\n`;

    // Act
    const sut = detectBannedSutName(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it("Given `const subject = …` inside a unit it(), When scanned, Then a finding with alias='subject'", () => {
    // Arrange
    const source = `\nit('Given x, When y, Then z', () => {\n  const subject = build();\n  expect(subject).toBeDefined();\n});\n`;

    // Act
    const sut = detectBannedSutName(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([
      {
        path: 'test/unit/a.test.ts',
        line: 2,
        title: 'Given x, When y, Then z',
        alias: 'subject',
      },
    ]);
  });

  it("Given `let objectUnderTest = …`, When scanned, Then a finding with alias='objectUnderTest'", () => {
    // Arrange
    const source = `\nit('Given x, When y, Then z', () => {\n  let objectUnderTest = build();\n  expect(objectUnderTest).toBeDefined();\n});\n`;

    // Act
    const sut = detectBannedSutName(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.alias).toBe('objectUnderTest');
  });

  it("Given `var systemUnderTest = …`, When scanned, Then a finding with alias='systemUnderTest'", () => {
    // Arrange
    const source = `\nit('Given x, When y, Then z', () => {\n  var systemUnderTest = build();\n  expect(systemUnderTest).toBeDefined();\n});\n`;

    // Act
    const sut = detectBannedSutName(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.alias).toBe('systemUnderTest');
  });

  it("Given `const cut = …`, When scanned, Then a finding with alias='cut'", () => {
    // Arrange
    const source = `\nit('Given x, When y, Then z', () => {\n  const cut = build();\n  expect(cut).toBeDefined();\n});\n`;

    // Act
    const sut = detectBannedSutName(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.alias).toBe('cut');
  });

  it('Given a destructured `const { subject } = …`, When scanned, Then no finding (documented limitation)', () => {
    // Arrange — the binding `subject` lives inside a destructuring pattern,
    // which the deny-list regex does not catch (intentional).
    const source = `\nit('Given x, When y, Then z', () => {\n  const { subject } = fixture();\n  expect(subject).toBeDefined();\n});\n`;

    // Act
    const sut = detectBannedSutName(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given a property read of `.subject` (not a declaration), When scanned, Then no finding', () => {
    // Arrange
    const source = `\nit('Given x, When y, Then z', () => {\n  const value = obj.subject;\n  expect(value).toBeDefined();\n});\n`;

    // Act
    const sut = detectBannedSutName(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given a banned-name declaration inside an it.skip block, When scanned, Then no finding (skip exempt)', () => {
    // Arrange
    const source = `\nit.skip('Given x, When y, Then z', () => {\n  const subject = build();\n});\n`;

    // Act
    const sut = detectBannedSutName(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given a banned name in an integration test file, When scanned, Then no finding (heuristic scoped to unit)', () => {
    // Arrange
    const source = `it('whatever', () => { const subject = build(); expect(subject).toBeDefined(); });`;

    // Act
    const sut = detectBannedSutName(MANIFEST, [file('test/integration/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given multiple files with findings, When scanned, Then they are sorted by path then by line', () => {
    // Arrange
    const sourceA = `\nit('Given a, When b, Then c', () => { const subject = 1; expect(subject).toBe(1); });\n`;
    const sourceB = `\nit('Given d, When e, Then f', () => { const cut = 1; expect(cut).toBe(1); });\nit('Given g, When h, Then i', () => { const subject = 2; expect(subject).toBe(2); });\n`;

    // Act
    const sut = detectBannedSutName(MANIFEST, [
      file('test/unit/b.test.ts', sourceB),
      file('test/unit/a.test.ts', sourceA),
    ]);

    // Assert
    expect(sut.map((f) => f.path)).toEqual([
      'test/unit/a.test.ts',
      'test/unit/b.test.ts',
      'test/unit/b.test.ts',
    ]);
  });

  it('Given a custom banned list with a single alias, When that alias appears, Then a finding is emitted', () => {
    // Arrange
    const custom = makeManifest({ sutBanned: ['target'] });
    const source = `\nit('Given x, When y, Then z', () => { const target = 1; expect(target).toBe(1); });\n`;

    // Act
    const sut = detectBannedSutName(custom, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.alias).toBe('target');
  });
});
