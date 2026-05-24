import { describe, expect, it } from 'vitest';
import { classifyTestFile } from '../../../test-pyramid/classify-test-file.js';
import type { PyramidManifest } from '../../../test-pyramid/parse-manifest.js';
import { makeManifest } from './manifest-fixture.js';

const MANIFEST = makeManifest();

describe('classifyTestFile', () => {
  describe("Given a path under test/unit", () => {
    describe("When classified", () => {
      it('Then returns "unit"', () => {
    // Arrange + Act
    const sut = classifyTestFile(MANIFEST, 'test/unit/domain/blob.test.ts');

    // Assert
    expect(sut).toBe('unit');
  });
    });
  });

  describe("Given a path under test/integration", () => {
    describe("When classified", () => {
      it('Then returns "integration"', () => {
    // Arrange + Act
    const sut = classifyTestFile(MANIFEST, 'test/integration/clone.test.ts');

    // Assert
    expect(sut).toBe('integration');
  });
    });
  });

  describe("Given a path under test/integration/posix-only", () => {
    describe("When classified", () => {
      it('Then returns "integration"', () => {
    // Arrange + Act
    const sut = classifyTestFile(MANIFEST, 'test/integration/posix-only/file-mode.test.ts');

    // Assert
    expect(sut).toBe('integration');
  });
    });
  });

  describe("Given a path under test/integration/win-only", () => {
    describe("When classified", () => {
      it('Then returns "integration"', () => {
    // Arrange + Act
    const sut = classifyTestFile(MANIFEST, 'test/integration/win-only/short-name.test.ts');

    // Assert
    expect(sut).toBe('integration');
  });
    });
  });

  describe("Given a Playwright spec under test/browser", () => {
    describe("When classified", () => {
      it('Then returns "e2e"', () => {
    // Arrange + Act
    const sut = classifyTestFile(MANIFEST, 'test/browser/surface-parity.spec.ts');

    // Assert
    expect(sut).toBe('e2e');
  });
    });
  });

  describe("Given a fixture data file", () => {
    describe("When classified", () => {
      it('Then returns "unclassified"', () => {
    // Arrange + Act
    const sut = classifyTestFile(MANIFEST, 'test/fixtures/repo.ts');

    // Assert
    expect(sut).toBe('unclassified');
  });
    });
  });

  describe("Given a bench file", () => {
    describe("When classified", () => {
      it('Then returns "unclassified"', () => {
    // Arrange + Act
    const sut = classifyTestFile(MANIFEST, 'test/bench/log.bench.ts');

    // Assert
    expect(sut).toBe('unclassified');
  });
    });
  });

  describe("Given a source file under src/", () => {
    describe("When classified", () => {
      it('Then returns "unclassified"', () => {
    // Arrange + Act
    const sut = classifyTestFile(MANIFEST, 'src/domain/blob.ts');

    // Assert
    expect(sut).toBe('unclassified');
  });
    });
  });

  describe("Given a path with backslash separators (Windows style)", () => {
    describe("When classified", () => {
      it('Then returns the correct tier', () => {
    // Arrange + Act
    const sut = classifyTestFile(MANIFEST, 'test\\unit\\domain\\blob.test.ts');

    // Assert
    expect(sut).toBe('unit');
  });
    });
  });

  describe("Given a manifest with overlapping tier globs", () => {
    describe("When classifying", () => {
      it('Then returns the first matching tier', () => {
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
  });
});
