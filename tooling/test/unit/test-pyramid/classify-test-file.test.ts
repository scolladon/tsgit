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
    const result = classifyTestFile(MANIFEST, 'test/unit/domain/blob.test.ts');

    // Assert
    expect(result).toBe('unit');
  });
    });
  });

  describe("Given a path under test/integration", () => {
    describe("When classified", () => {
      it('Then returns "integration"', () => {
    // Arrange + Act
    const result = classifyTestFile(MANIFEST, 'test/integration/clone.test.ts');

    // Assert
    expect(result).toBe('integration');
  });
    });
  });

  describe("Given a path under test/integration/posix-only", () => {
    describe("When classified", () => {
      it('Then returns "integration"', () => {
    // Arrange + Act
    const result = classifyTestFile(MANIFEST, 'test/integration/posix-only/file-mode.test.ts');

    // Assert
    expect(result).toBe('integration');
  });
    });
  });

  describe("Given a path under test/integration/win-only", () => {
    describe("When classified", () => {
      it('Then returns "integration"', () => {
    // Arrange + Act
    const result = classifyTestFile(MANIFEST, 'test/integration/win-only/short-name.test.ts');

    // Assert
    expect(result).toBe('integration');
  });
    });
  });

  describe("Given a Playwright spec under test/browser", () => {
    describe("When classified", () => {
      it('Then returns "e2e"', () => {
    // Arrange + Act
    const result = classifyTestFile(MANIFEST, 'test/browser/surface-parity.spec.ts');

    // Assert
    expect(result).toBe('e2e');
  });
    });
  });

  describe("Given a fixture data file", () => {
    describe("When classified", () => {
      it('Then returns "unclassified"', () => {
    // Arrange + Act
    const result = classifyTestFile(MANIFEST, 'test/fixtures/repo.ts');

    // Assert
    expect(result).toBe('unclassified');
  });
    });
  });

  describe("Given a bench file", () => {
    describe("When classified", () => {
      it('Then returns "unclassified"', () => {
    // Arrange + Act
    const result = classifyTestFile(MANIFEST, 'test/bench/log.bench.ts');

    // Assert
    expect(result).toBe('unclassified');
  });
    });
  });

  describe("Given a source file under src/", () => {
    describe("When classified", () => {
      it('Then returns "unclassified"', () => {
    // Arrange + Act
    const result = classifyTestFile(MANIFEST, 'src/domain/blob.ts');

    // Assert
    expect(result).toBe('unclassified');
  });
    });
  });

  describe("Given a path with backslash separators (Windows style)", () => {
    describe("When classified", () => {
      it('Then returns the correct tier', () => {
    // Arrange + Act
    const result = classifyTestFile(MANIFEST, 'test\\unit\\domain\\blob.test.ts');

    // Assert
    expect(result).toBe('unit');
  });
    });
  });

  describe("Given a manifest defining a parity tier", () => {
    describe("When classifying a path under test/parity", () => {
      it('Then returns "parity"', () => {
    // Arrange
    const withParity: PyramidManifest = {
      ...MANIFEST,
      tiers: [
        ...MANIFEST.tiers,
        { name: 'parity', glob: 'test/parity/**/*.test.ts', target: 0, warnBelow: 0, warnAbove: null },
      ],
    };

    // Act
    const result = classifyTestFile(withParity, 'test/parity/node.test.ts');

    // Assert
    expect(result).toBe('parity');
  });
    });
  });

  describe("Given a manifest defining a runtime-parity tier", () => {
    describe("When classifying a path under test/runtime-parity", () => {
      it('Then returns "runtime-parity"', () => {
    // Arrange
    const withRuntimeParity: PyramidManifest = {
      ...MANIFEST,
      tiers: [
        ...MANIFEST.tiers,
        {
          name: 'runtime-parity',
          glob: 'test/runtime-parity/**/*.test.ts',
          target: 0,
          warnBelow: 0,
          warnAbove: null,
        },
      ],
    };

    // Act
    const result = classifyTestFile(withRuntimeParity, 'test/runtime-parity/deno/parity-node.test.ts');

    // Assert
    expect(result).toBe('runtime-parity');
  });
    });
  });

  describe("Given a manifest defining a perf tier", () => {
    describe("When classifying a path under test/perf", () => {
      it('Then returns "perf"', () => {
    // Arrange
    const withPerf: PyramidManifest = {
      ...MANIFEST,
      tiers: [
        ...MANIFEST.tiers,
        { name: 'perf', glob: 'test/perf/**/*.test.ts', target: 0, warnBelow: 0, warnAbove: null },
      ],
    };

    // Act
    const result = classifyTestFile(withPerf, 'test/perf/domain/pathspec/compile-glob.perf.test.ts');

    // Assert
    expect(result).toBe('perf');
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
    const result = classifyTestFile(overlap, 'test/integration/clone.test.ts');

    // Assert
    expect(result).toBe('unit');
  });
    });
  });
});
