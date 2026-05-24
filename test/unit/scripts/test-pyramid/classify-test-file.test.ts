import { describe, expect, it } from 'vitest';
import { classifyTestFile } from '../../../../scripts/test-pyramid/classify-test-file.js';
import type { PyramidManifest } from '../../../../scripts/test-pyramid/parse-manifest.js';
import { makeManifest } from './manifest-fixture.js';

const MANIFEST = makeManifest();

describe('classifyTestFile', () => {
  it('Given a path under test/unit, When classified, Then returns "unit"', () => {
    // Arrange + Act
    const sut = classifyTestFile(MANIFEST, 'test/unit/domain/blob.test.ts');

    // Assert
    expect(sut).toBe('unit');
  });

  it('Given a path under test/integration, When classified, Then returns "integration"', () => {
    // Arrange + Act
    const sut = classifyTestFile(MANIFEST, 'test/integration/clone.test.ts');

    // Assert
    expect(sut).toBe('integration');
  });

  it('Given a path under test/integration/posix-only, When classified, Then returns "integration"', () => {
    // Arrange + Act
    const sut = classifyTestFile(MANIFEST, 'test/integration/posix-only/file-mode.test.ts');

    // Assert
    expect(sut).toBe('integration');
  });

  it('Given a path under test/integration/win-only, When classified, Then returns "integration"', () => {
    // Arrange + Act
    const sut = classifyTestFile(MANIFEST, 'test/integration/win-only/short-name.test.ts');

    // Assert
    expect(sut).toBe('integration');
  });

  it('Given a Playwright spec under test/browser, When classified, Then returns "e2e"', () => {
    // Arrange + Act
    const sut = classifyTestFile(MANIFEST, 'test/browser/surface-parity.spec.ts');

    // Assert
    expect(sut).toBe('e2e');
  });

  it('Given a fixture data file, When classified, Then returns "unclassified"', () => {
    // Arrange + Act
    const sut = classifyTestFile(MANIFEST, 'test/fixtures/repo.ts');

    // Assert
    expect(sut).toBe('unclassified');
  });

  it('Given a bench file, When classified, Then returns "unclassified"', () => {
    // Arrange + Act
    const sut = classifyTestFile(MANIFEST, 'test/bench/log.bench.ts');

    // Assert
    expect(sut).toBe('unclassified');
  });

  it('Given a source file under src/, When classified, Then returns "unclassified"', () => {
    // Arrange + Act
    const sut = classifyTestFile(MANIFEST, 'src/domain/blob.ts');

    // Assert
    expect(sut).toBe('unclassified');
  });

  it('Given a path with backslash separators (Windows style), When classified, Then returns the correct tier', () => {
    // Arrange + Act
    const sut = classifyTestFile(MANIFEST, 'test\\unit\\domain\\blob.test.ts');

    // Assert
    expect(sut).toBe('unit');
  });

  it('Given a manifest with overlapping tier globs, When classifying, Then returns the first matching tier', () => {
    // Arrange
    const overlap: PyramidManifest = {
      ...MANIFEST,
      tiers: [
        { ...MANIFEST.tiers[0]!, glob: 'test/**/*.test.ts' },
        MANIFEST.tiers[1]!,
        MANIFEST.tiers[2]!,
      ],
    };

    // Act
    const sut = classifyTestFile(overlap, 'test/integration/clone.test.ts');

    // Assert
    expect(sut).toBe('unit');
  });
});
