import { describe, expect, it } from 'vitest';
import { detectEmptyAaaSection } from '../../../test-pyramid/detect-empty-aaa-section.js';
import { makeManifest } from './manifest-fixture.js';

const MANIFEST = makeManifest();
const file = (path: string, source: string) => ({ path, source });

describe('detectEmptyAaaSection', () => {
  it('Given Arrange and Assert sections both non-empty, When scanned, Then no finding', () => {
    // Arrange
    const source = `\nit('Given x, When y, Then z', () => {\n  // Arrange\n  const sut = 1;\n  // Assert\n  expect(sut).toBe(1);\n});\n`;

    // Act
    const sut = detectEmptyAaaSection(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given Arrange empty followed directly by Assert with a single statement, When scanned, Then finding under Arrange', () => {
    // Arrange
    const source = `\nit('Given x, When y, Then z', () => {\n  // Arrange\n  // Assert\n  expect(1).toBe(1);\n});\n`;

    // Act
    const sut = detectEmptyAaaSection(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.marker).toBe('Arrange');
    expect(sut[0]?.path).toBe('test/unit/a.test.ts');
  });

  it('Given Arrange with a statement and Assert followed only by closing brace, When scanned, Then finding under Assert', () => {
    // Arrange
    const source = `\nit('Given x, When y, Then z', () => {\n  // Arrange\n  const sut = 1;\n  // Assert\n});\n`;

    // Act
    const sut = detectEmptyAaaSection(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.marker).toBe('Assert');
  });

  it('Given Arrange empty with Act and Assert both populated, When scanned, Then finding only under Arrange', () => {
    // Arrange
    const source = `\nit('Given x, When y, Then z', () => {\n  // Arrange\n  // Act\n  const sut = doIt();\n\n  // Assert\n  expect(sut).toBe(1);\n});\n`;

    // Act
    const sut = detectEmptyAaaSection(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.marker).toBe('Arrange');
  });

  it('Given every section empty, When scanned, Then a finding per empty marker, sorted by line', () => {
    // Arrange
    const source = `\nit('Given x, When y, Then z', () => {\n  // Arrange\n  // Act\n  // Assert\n});\n`;

    // Act
    const sut = detectEmptyAaaSection(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert — each marker introduces an empty section; three findings, in marker order.
    expect(sut.map((f) => f.marker)).toEqual(['Arrange', 'Act', 'Assert']);
  });

  it('Given a compound // Arrange + Act marker line followed by one statement, When scanned, Then no finding', () => {
    // Arrange — compound marker counts as a single marker line; the section underneath has content.
    const source = `\nit('Given x, When y, Then z', () => {\n  // Arrange + Act\n  const sut = doIt();\n\n  // Assert\n  expect(sut).toBe(1);\n});\n`;

    // Act
    const sut = detectEmptyAaaSection(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given an Arrange section containing only a block comment, When scanned, Then a finding (block comment is not statement-bearing)', () => {
    // Arrange
    const source = `\nit('Given x, When y, Then z', () => {\n  // Arrange\n  /* note */\n  // Assert\n  expect(1).toBe(1);\n});\n`;

    // Act
    const sut = detectEmptyAaaSection(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.marker).toBe('Arrange');
  });

  it('Given an Arrange section containing only a line-comment, When scanned, Then a finding (line comment is not statement-bearing)', () => {
    // Arrange
    const source = `\nit('Given x, When y, Then z', () => {\n  // Arrange\n  // a chatty comment\n  // Assert\n  expect(1).toBe(1);\n});\n`;

    // Act
    const sut = detectEmptyAaaSection(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.marker).toBe('Arrange');
  });

  it('Given Arrange followed only by a closing-bracket line then Assert, When scanned, Then a finding under Arrange', () => {
    // Arrange — closing brackets are not statement-bearing lines.
    const source = `\nit('Given x, When y, Then z', () => {\n  // Arrange\n  })\n  // Assert\n  expect(1).toBe(1);\n});\n`;

    // Act
    const sut = detectEmptyAaaSection(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.marker).toBe('Arrange');
  });

  it('Given an it.skip block with empty sections, When scanned, Then no finding (skip exempt)', () => {
    // Arrange
    const source = `\nit.skip('Given x, When y, Then z', () => {\n  // Arrange\n  // Assert\n});\n`;

    // Act
    const sut = detectEmptyAaaSection(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given an integration file with empty sections, When scanned, Then no finding (heuristic scoped to unit)', () => {
    // Arrange
    const source = `\nit('whatever', () => {\n  // Arrange\n  // Assert\n  expect(1).toBe(1);\n});\n`;

    // Act
    const sut = detectEmptyAaaSection(MANIFEST, [file('test/integration/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given findings across multiple files, When scanned, Then sorted by path then by line', () => {
    // Arrange
    const sourceA = `\nit('Given a, When b, Then c', () => {\n  // Arrange\n  // Assert\n  expect(1).toBe(1);\n});\n`;
    const sourceB = `\nit('Given a, When b, Then c', () => {\n  // Arrange\n  // Assert\n  expect(1).toBe(1);\n});\nit('Given d, When e, Then f', () => {\n  // Arrange\n  // Assert\n  expect(2).toBe(2);\n});\n`;

    // Act
    const sut = detectEmptyAaaSection(MANIFEST, [
      file('test/unit/b.test.ts', sourceB),
      file('test/unit/a.test.ts', sourceA),
    ]);

    // Assert
    expect(sut.map((f) => f.path)).toEqual([
      'test/unit/a.test.ts',
      'test/unit/b.test.ts',
      'test/unit/b.test.ts',
    ]);
    expect(sut).toHaveLength(3);
    expect(sut[2]!.line).toBeGreaterThan(sut[1]!.line);
  });

  it('Given a body with a marker present but no other markers, When the section under it is empty, Then a finding is emitted', () => {
    // Arrange — single-marker body: the section under the marker is the body remainder.
    const source = `\nit('Given x, When y, Then z', () => {\n  // Arrange\n});\n`;

    // Act
    const sut = detectEmptyAaaSection(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.marker).toBe('Arrange');
  });

  it('Given a body with no AAA markers at all, When scanned, Then no finding (heuristic only checks present markers)', () => {
    // Arrange
    const source = `\nit('Given x, When y, Then z', () => {\n  expect(1).toBe(1);\n});\n`;

    // Act
    const sut = detectEmptyAaaSection(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given marker indentation with tabs and spaces, When scanned, Then both forms are honoured', () => {
    // Arrange
    const source = `\nit('Given x, When y, Then z', () => {\n\t// Arrange\n  const sut = 1;\n\t\t// Assert\n  expect(sut).toBe(1);\n});\n`;

    // Act
    const sut = detectEmptyAaaSection(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given marker line carrying trailing prose, When the section underneath has content, Then no finding', () => {
    // Arrange — prose on the marker line itself does not count toward the section content; the next line does.
    const source = `\nit('Given x, When y, Then z', () => {\n  // Arrange — fixture setup\n  const sut = 1;\n  // Assert\n  expect(sut).toBe(1);\n});\n`;

    // Act
    const sut = detectEmptyAaaSection(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given a compound // Act + Arrange marker line (Act textually first), When the section underneath is empty, Then the finding names Act', () => {
    // Arrange — non-canonical ordering exercises the textual-position rule from ADR-115.
    const source = `\nit('Given x, When y, Then z', () => {\n  // Act + Arrange\n  // Assert\n  expect(1).toBe(1);\n});\n`;

    // Act
    const sut = detectEmptyAaaSection(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert — the marker owner is whichever name appears FIRST textually on the compound line.
    expect(sut).toHaveLength(1);
    expect(sut[0]!.marker).toBe('Act');
  });

  it('Given a section containing only a multi-line block comment, When scanned, Then a finding (block-comment continuation lines are not statement-bearing)', () => {
    // Arrange
    const source =
      "\nit('Given x, When y, Then z', () => {\n  // Arrange\n  /*\n   * just a note\n   */\n  // Assert\n  expect(1).toBe(1);\n});\n";

    // Act
    const sut = detectEmptyAaaSection(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]!.marker).toBe('Arrange');
  });
});
