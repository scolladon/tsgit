import { describe, expect, it } from 'vitest';
import { detectSutBindsResult } from '../../../test-pyramid/detect-sut-binds-result.js';
import type { PyramidManifest } from '../../../test-pyramid/parse-manifest.js';
import { makeManifest } from './manifest-fixture.js';

const MANIFEST = makeManifest();
const file = (path: string, source: string) => ({ path, source });

describe('detectSutBindsResult', () => {
  it('Given `const sut = crc32(data)` in a unit it(), When scanned, Then a finding names the callee', () => {
    // Arrange
    const source = `\nit('Given x, When y, Then z', () => {\n  // Arrange\n  const sut = crc32(data);\n  // Assert\n  expect(sut).toBe(1);\n});\n`;

    // Act
    const sut = detectSutBindsResult(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([
      {
        path: 'test/unit/a.test.ts',
        line: 2,
        title: 'Given x, When y, Then z',
        callee: 'crc32',
      },
    ]);
  });

  it('Given `const sut = new NodeHashService(...)`, When scanned, Then no finding (object under test)', () => {
    // Arrange
    const source = `\nit('Given x, When y, Then z', () => {\n  const sut = new NodeHashService('sha256');\n  expect(sut.digestLength).toBe(32);\n});\n`;

    // Act
    const sut = detectSutBindsResult(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given `const sut = openRepository(adapters, dir)`, When scanned, Then no finding (allowlisted factory)', () => {
    // Arrange
    const source = `\nit('Given x, When y, Then z', () => {\n  const sut = openRepository(adapters, dir);\n  expect(sut).toBeDefined();\n});\n`;

    // Act
    const sut = detectSutBindsResult(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given `const sut = ObjectId.from` (bare reference, no call), When scanned, Then no finding', () => {
    // Arrange
    const source = `\nit('Given x, When y, Then z', () => {\n  const sut = ObjectId.from;\n  expect(() => sut(hex)).toThrow();\n});\n`;

    // Act
    const sut = detectSutBindsResult(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given `const sut = await createMemoryContext(...)`, When scanned, Then no finding (allowlisted, awaited)', () => {
    // Arrange
    const source = `\nit('Given x, When y, Then z', () => {\n  const sut = await createMemoryContext();\n  expect(sut).toBeDefined();\n});\n`;

    // Act
    const sut = detectSutBindsResult(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given `const sut = a.b.build(...)` (dotted/member call), When scanned, Then no finding (out of scope for a bare-call detector)', () => {
    // Arrange
    const source = `\nit('Given x, When y, Then z', () => {\n  const sut = fixtures.factory.build(1);\n  expect(sut).toBeDefined();\n});\n`;

    // Act
    const sut = detectSutBindsResult(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given a banned-name declaration inside an it.skip block, When scanned, Then no finding (skip exempt)', () => {
    // Arrange
    const source = `\nit.skip('Given x, When y, Then z', () => {\n  const sut = crc32(data);\n});\n`;

    // Act
    const sut = detectSutBindsResult(MANIFEST, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given a bare call in an e2e test file, When scanned, Then no finding (heuristic scoped to configured tiers)', () => {
    // Arrange
    const scopedManifest: PyramidManifest = {
      ...MANIFEST,
      heuristics: {
        ...MANIFEST.heuristics,
        sutBindsResult: { ...MANIFEST.heuristics.sutBindsResult, tiers: ['unit'] },
      },
    };
    const source = `it('whatever', () => { const sut = crc32(data); expect(sut).toBe(1); });`;

    // Act
    const sut = detectSutBindsResult(scopedManifest, [file('test/browser/a.spec.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given a heuristic scoped to tiers unit and integration, When both a unit and an integration file bind a call result, Then both are flagged', () => {
    // Arrange
    const multiTier: PyramidManifest = {
      ...MANIFEST,
      heuristics: {
        ...MANIFEST.heuristics,
        sutBindsResult: { ...MANIFEST.heuristics.sutBindsResult, tiers: ['unit', 'integration'] },
      },
    };
    const source = `it('whatever', () => { const sut = crc32(data); expect(sut).toBe(1); });`;

    // Act
    const sut = detectSutBindsResult(multiTier, [
      file('test/unit/a.test.ts', source),
      file('test/integration/b.test.ts', source),
    ]);

    // Assert
    expect(sut.map((f) => f.path)).toEqual(['test/integration/b.test.ts', 'test/unit/a.test.ts']);
  });

  it('Given multiple files with findings, When scanned, Then they are sorted by path then by line', () => {
    // Arrange
    const sourceA = `\nit('Given a, When b, Then c', () => { const sut = crc32(1); expect(sut).toBe(1); });\n`;
    const sourceB = `\nit('Given d, When e, Then f', () => { const sut = crc32(2); expect(sut).toBe(2); });\nit('Given g, When h, Then i', () => { const sut = crc32(3); expect(sut).toBe(3); });\n`;

    // Act
    const sut = detectSutBindsResult(MANIFEST, [
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

  it('Given a custom allowlist with a single factory, When that factory is called, Then no finding is emitted', () => {
    // Arrange
    const custom = makeManifest({ sutBindsResultAllowlist: ['buildGrepMatcher'] });
    const source = `\nit('Given x, When y, Then z', () => { const sut = buildGrepMatcher(pattern); expect(sut).toBeDefined(); });\n`;

    // Act
    const sut = detectSutBindsResult(custom, [file('test/unit/a.test.ts', source)]);

    // Assert
    expect(sut).toEqual([]);
  });
});
