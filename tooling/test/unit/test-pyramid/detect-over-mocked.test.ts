import { describe, expect, it } from 'vitest';
import { detectOverMocked } from '../../../test-pyramid/detect-over-mocked.js';
import type { PyramidManifest } from '../../../test-pyramid/parse-manifest.js';
import { makeManifest } from './manifest-fixture.js';

const MANIFEST = makeManifest();

describe('detectOverMocked', () => {
  it('Given an integration file with no vi.* calls, When scanned, Then no finding is returned', () => {
    // Arrange
    const files = [
      {
        path: 'test/integration/clone.test.ts',
        source: 'import { it } from "vitest"; it("x", () => { expect(1).toBe(1); });',
      },
    ];

    // Act
    const sut = detectOverMocked(MANIFEST, files);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given an integration file with one vi.mock call, When scanned, Then one finding with hits=1', () => {
    // Arrange
    const files = [
      {
        path: 'test/integration/clone.test.ts',
        source: 'vi.mock("./module");',
      },
    ];

    // Act
    const sut = detectOverMocked(MANIFEST, files);

    // Assert
    expect(sut).toEqual([{ path: 'test/integration/clone.test.ts', hits: 1 }]);
  });

  it('Given an integration file with mixed vi.* calls (mock + fn + spyOn), When scanned, Then hits totals 3', () => {
    // Arrange
    const files = [
      {
        path: 'test/integration/clone.test.ts',
        source: 'vi.mock("a"); const m = vi.fn(); vi.spyOn(obj, "method");',
      },
    ];

    // Act
    const sut = detectOverMocked(MANIFEST, files);

    // Assert
    expect(sut).toHaveLength(1);
    expect(sut[0]?.hits).toBe(3);
  });

  it('Given an integration file that only uses vi.useFakeTimers, When scanned, Then no finding (timer control is exempt)', () => {
    // Arrange
    const files = [
      {
        path: 'test/integration/clone.test.ts',
        source: 'vi.useFakeTimers(); vi.advanceTimersByTime(1000);',
      },
    ];

    // Act
    const sut = detectOverMocked(MANIFEST, files);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given a file in a non-integration tier, When scanned, Then it is not considered (unit/e2e do not run this heuristic)', () => {
    // Arrange — the caller is expected to pre-filter, but the scanner must
    // ignore any file whose tier is not the heuristic's configured tier.
    const files = [
      {
        path: 'test/unit/foo.test.ts',
        source: 'vi.mock("a");',
      },
    ];

    // Act
    const sut = detectOverMocked(MANIFEST, files);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given multiple integration files, When scanned, Then findings are sorted by path ascending', () => {
    // Arrange
    const files = [
      { path: 'test/integration/z.test.ts', source: 'vi.mock("a");' },
      { path: 'test/integration/a.test.ts', source: 'vi.fn();' },
      { path: 'test/integration/m.test.ts', source: 'vi.mock("c"); vi.spyOn(o, "m");' },
    ];

    // Act
    const sut = detectOverMocked(MANIFEST, files);

    // Assert
    expect(sut.map((f) => f.path)).toEqual([
      'test/integration/a.test.ts',
      'test/integration/m.test.ts',
      'test/integration/z.test.ts',
    ]);
  });

  it('Given a file whose vi.mock(...) call sits inside a comment, When scanned, Then a finding is still reported (false positive accepted per ADR-107)', () => {
    // Arrange
    const files = [
      {
        path: 'test/integration/clone.test.ts',
        source: '// example: vi.mock("./bad-pattern") — do not do this',
      },
    ];

    // Act
    const sut = detectOverMocked(MANIFEST, files);

    // Assert
    expect(sut[0]?.hits).toBe(1);
  });

  it('Given a stubEnv call, When scanned, Then it is counted (env stub belongs in unit tests)', () => {
    // Arrange
    const files = [
      {
        path: 'test/integration/clone.test.ts',
        source: 'vi.stubEnv("CI", "true");',
      },
    ];

    // Act
    const sut = detectOverMocked(MANIFEST, files);

    // Assert
    expect(sut[0]?.hits).toBe(1);
  });

  it('Given a file with vi.mock surrounded by whitespace and parentheses, When scanned, Then the count is accurate', () => {
    // Arrange
    const files = [
      {
        path: 'test/integration/clone.test.ts',
        source: '  vi.mock  (\n    "deep/module"\n  );',
      },
    ];

    // Act
    const sut = detectOverMocked(MANIFEST, files);

    // Assert
    expect(sut[0]?.hits).toBe(1);
  });

  it('Given threshold=2 and a file with exactly 2 hits, When scanned, Then no finding (boundary case — hits must exceed threshold)', () => {
    // Arrange
    const lenient: PyramidManifest = {
      ...MANIFEST,
      heuristics: {
        ...MANIFEST.heuristics,
        overMockedIntegration: {
          ...MANIFEST.heuristics.overMockedIntegration,
          threshold: 2,
        },
      },
    };
    const files = [
      {
        path: 'test/integration/clone.test.ts',
        source: 'vi.mock("a"); vi.fn();',
      },
    ];

    // Act
    const sut = detectOverMocked(lenient, files);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given threshold=2 and a file with exactly 3 hits, When scanned, Then a finding is reported with hits=3', () => {
    // Arrange
    const lenient: PyramidManifest = {
      ...MANIFEST,
      heuristics: {
        ...MANIFEST.heuristics,
        overMockedIntegration: {
          ...MANIFEST.heuristics.overMockedIntegration,
          threshold: 2,
        },
      },
    };
    const files = [
      {
        path: 'test/integration/clone.test.ts',
        source: 'vi.mock("a"); vi.fn(); vi.spyOn(o, "m");',
      },
    ];

    // Act
    const sut = detectOverMocked(lenient, files);

    // Assert
    expect(sut).toEqual([{ path: 'test/integration/clone.test.ts', hits: 3 }]);
  });

  it('Given an empty file list, When scanned, Then an empty array is returned', () => {
    // Arrange + Act
    const sut = detectOverMocked(MANIFEST, []);

    // Assert
    expect(sut).toEqual([]);
  });
});
