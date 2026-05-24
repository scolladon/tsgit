import { describe, expect, it } from 'vitest';
import { tallyTierFiles } from '../../../test-pyramid/count-tier-files.js';
import { makeManifest } from './manifest-fixture.js';

const MANIFEST = makeManifest();

const unitPaths = (count: number): string[] =>
  Array.from({ length: count }, (_, i) => `test/unit/foo${i}.test.ts`);
const integrationPaths = (count: number): string[] =>
  Array.from({ length: count }, (_, i) => `test/integration/bar${i}.test.ts`);
const e2ePaths = (count: number): string[] =>
  Array.from({ length: count }, (_, i) => `test/browser/baz${i}.spec.ts`);

describe('tallyTierFiles', () => {
  it('Given no input files, When tallied, Then all tier counts are 0 and totalClassified is 0', () => {
    // Arrange + Act
    const sut = tallyTierFiles(MANIFEST, []);

    // Assert
    expect(sut.totalClassified).toBe(0);
    expect(sut.tiers).toHaveLength(3);
    for (const tier of sut.tiers) {
      expect(tier.fileCount).toBe(0);
      expect(tier.sharePct).toBe(0);
    }
  });

  it('Given 8 unit + 1 integration + 1 e2e, When tallied, Then shares are 80.0 / 10.0 / 10.0', () => {
    // Arrange
    const paths = [...unitPaths(8), ...integrationPaths(1), ...e2ePaths(1)];

    // Act
    const sut = tallyTierFiles(MANIFEST, paths);

    // Assert
    expect(sut.totalClassified).toBe(10);
    expect(sut.tiers.find((t) => t.tier === 'unit')?.sharePct).toBe(80.0);
    expect(sut.tiers.find((t) => t.tier === 'integration')?.sharePct).toBe(10.0);
    expect(sut.tiers.find((t) => t.tier === 'e2e')?.sharePct).toBe(10.0);
  });

  it('Given the 207/24/4 baseline, When tallied, Then shares round to 88.0 / 10.2 / 1.7', () => {
    // Arrange
    const paths = [...unitPaths(207), ...integrationPaths(24), ...e2ePaths(4)];

    // Act
    const sut = tallyTierFiles(MANIFEST, paths);

    // Assert
    expect(sut.totalClassified).toBe(235);
    expect(sut.tiers.find((t) => t.tier === 'unit')?.sharePct).toBe(88.1);
    expect(sut.tiers.find((t) => t.tier === 'integration')?.sharePct).toBe(10.2);
    expect(sut.tiers.find((t) => t.tier === 'e2e')?.sharePct).toBe(1.7);
  });

  it('Given a path that no tier matches, When tallied, Then it appears in unclassified and is excluded from share denominator', () => {
    // Arrange
    const paths = [...unitPaths(8), 'test/fixtures/data.ts', 'docs/note.md'];

    // Act
    const sut = tallyTierFiles(MANIFEST, paths);

    // Assert
    expect(sut.totalClassified).toBe(8);
    expect(sut.unclassified).toEqual(['test/fixtures/data.ts', 'docs/note.md']);
    expect(sut.tiers.find((t) => t.tier === 'unit')?.sharePct).toBe(100.0);
  });

  it('Given a unit share below the warn-below threshold, When tallied, Then unit tier status is "warn-below"', () => {
    // Arrange — 7 unit / 2 integration / 1 e2e → unit share = 70%, below 75 warn floor
    const paths = [...unitPaths(7), ...integrationPaths(2), ...e2ePaths(1)];

    // Act
    const sut = tallyTierFiles(MANIFEST, paths);

    // Assert
    expect(sut.tiers.find((t) => t.tier === 'unit')?.status).toBe('warn-below');
  });

  it('Given an integration share above its warnAbove ceiling, When tallied, Then integration status is "warn-above"', () => {
    // Arrange — 6 unit / 4 integration / 0 e2e → integration share = 40%, above 25 warnAbove
    const paths = [...unitPaths(6), ...integrationPaths(4)];

    // Act
    const sut = tallyTierFiles(MANIFEST, paths);

    // Assert
    expect(sut.tiers.find((t) => t.tier === 'integration')?.status).toBe('warn-above');
  });

  it('Given the e2e tier below its warn-below floor, When tallied, Then e2e status is "warn-below"', () => {
    // Arrange — 207/24/4: e2e = 1.7%, below 3% floor
    const paths = [...unitPaths(207), ...integrationPaths(24), ...e2ePaths(4)];

    // Act
    const sut = tallyTierFiles(MANIFEST, paths);

    // Assert
    expect(sut.tiers.find((t) => t.tier === 'e2e')?.status).toBe('warn-below');
  });

  it('Given a tier whose target is met exactly, When tallied, Then status is "ok"', () => {
    // Arrange — 80/15/5
    const paths = [...unitPaths(80), ...integrationPaths(15), ...e2ePaths(5)];

    // Act
    const sut = tallyTierFiles(MANIFEST, paths);

    // Assert
    for (const tier of sut.tiers) {
      expect(tier.status).toBe('ok');
    }
  });

  it('Given a tier with no warnAbove, When the share is much higher than target, Then status remains "ok"', () => {
    // Arrange — unit at 100%, no warnAbove on unit tier
    const paths = unitPaths(10);

    // Act
    const sut = tallyTierFiles(MANIFEST, paths);

    // Assert
    expect(sut.tiers.find((t) => t.tier === 'unit')?.status).toBe('ok');
  });

  it('Given a unit share exactly equal to warnBelow (75%), When tallied, Then status is "ok" (strict less-than)', () => {
    // Arrange — 75 unit / 20 integration / 5 e2e → unit share = 75.0%, exactly the warnBelow floor.
    const paths = [...unitPaths(75), ...integrationPaths(20), ...e2ePaths(5)];

    // Act
    const sut = tallyTierFiles(MANIFEST, paths);

    // Assert
    expect(sut.tiers.find((t) => t.tier === 'unit')?.sharePct).toBe(75.0);
    expect(sut.tiers.find((t) => t.tier === 'unit')?.status).toBe('ok');
  });

  it('Given an integration share exactly equal to warnAbove (25%), When tallied, Then status is "ok" (strict greater-than)', () => {
    // Arrange — 65 unit / 25 integration / 10 e2e → integration share = 25.0%, exactly warnAbove.
    const paths = [...unitPaths(65), ...integrationPaths(25), ...e2ePaths(10)];

    // Act
    const sut = tallyTierFiles(MANIFEST, paths);

    // Assert
    expect(sut.tiers.find((t) => t.tier === 'integration')?.sharePct).toBe(25.0);
    expect(sut.tiers.find((t) => t.tier === 'integration')?.status).toBe('ok');
  });

  it('Given the result, When checked, Then tiers are returned in manifest order', () => {
    // Arrange
    const paths = [...unitPaths(8), ...integrationPaths(1), ...e2ePaths(1)];

    // Act
    const sut = tallyTierFiles(MANIFEST, paths);

    // Assert
    expect(sut.tiers.map((t) => t.tier)).toEqual(['unit', 'integration', 'e2e']);
  });
});
