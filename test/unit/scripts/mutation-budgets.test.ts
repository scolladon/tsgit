import { describe, expect, it } from 'vitest';
import type { BucketDefinition, StrykerMutationReport } from '../../../scripts/mutation-budgets.js';
import {
  bucketForPath,
  evaluateBudgets,
  parseManifest,
  parseReport,
} from '../../../scripts/mutation-budgets.js';

const VALID_MANIFEST = {
  buckets: [
    {
      name: 'domain',
      globs: ['src/domain/**'],
      thresholds: { high: 100, low: 100, break: 99 },
    },
    {
      name: 'application',
      globs: ['src/application/**', 'src/repository.ts'],
      thresholds: { high: 100, low: 98, break: 95 },
    },
    {
      name: 'adapters',
      globs: ['src/adapters/node/**'],
      thresholds: { high: 95, low: 90, break: 85 },
    },
    {
      name: 'infra',
      globs: ['src/operators/**'],
      thresholds: { high: 100, low: 95, break: 90 },
    },
  ],
} as const;

const REPORT_BASE = {
  schemaVersion: '1.0',
  thresholds: { high: 100, low: 95, break: 90 },
} as const;

const fileResult = (statuses: readonly string[]) => ({
  language: 'typescript',
  source: '// elided',
  mutants: statuses.map((status, id) => ({ id: String(id), status })),
});

describe('parseManifest', () => {
  it('Given an empty object, When parsed, Then throws with missing-buckets message', () => {
    // Arrange
    const raw = {};

    // Act + Assert
    // Assert
    expect(() => parseManifest(raw)).toThrowError(/manifest invalid: missing buckets array/);
  });

  it('Given a manifest with an empty buckets array, When parsed, Then throws (no buckets to enforce)', () => {
    // Arrange
    const raw = { buckets: [] };

    // Act + Assert
    // Assert
    expect(() => parseManifest(raw)).toThrowError(
      /manifest invalid: buckets array must not be empty/,
    );
  });

  it('Given a bucket missing the name field, When parsed, Then throws naming the offending bucket', () => {
    // Arrange
    const raw = {
      buckets: [{ globs: ['src/x/**'], thresholds: { high: 100, low: 95, break: 90 } }],
    };

    // Act + Assert
    // Assert
    expect(() => parseManifest(raw)).toThrowError(/manifest invalid: bucket\[0\] missing name/);
  });

  it('Given a bucket with an unknown name, When parsed, Then throws naming the bad value', () => {
    // Arrange
    const raw = {
      buckets: [
        {
          name: 'mystery',
          globs: ['src/x/**'],
          thresholds: { high: 100, low: 95, break: 90 },
        },
      ],
    };

    // Act + Assert
    // Assert
    expect(() => parseManifest(raw)).toThrowError(
      /manifest invalid: bucket\[0\] unknown name "mystery"/,
    );
  });

  it('Given a bucket with empty globs, When parsed, Then throws', () => {
    // Arrange
    const raw = {
      buckets: [
        {
          name: 'domain',
          globs: [],
          thresholds: { high: 100, low: 95, break: 90 },
        },
      ],
    };

    // Act + Assert
    // Assert
    expect(() => parseManifest(raw)).toThrowError(
      /manifest invalid: bucket\[0\] "domain" globs must not be empty/,
    );
  });

  it('Given a bucket with break threshold above 100, When parsed, Then throws', () => {
    // Arrange
    const raw = {
      buckets: [
        {
          name: 'domain',
          globs: ['src/**'],
          thresholds: { high: 100, low: 95, break: 101 },
        },
      ],
    };

    // Act + Assert
    // Assert
    expect(() => parseManifest(raw)).toThrowError(
      /manifest invalid: bucket\[0\] "domain" threshold break out of range/,
    );
  });

  it('Given the canonical 4-bucket manifest, When parsed, Then returns it unchanged', () => {
    // Arrange
    const raw = structuredClone(VALID_MANIFEST);

    // Act
    const sut = parseManifest(raw);

    // Assert
    expect(sut.buckets).toHaveLength(4);
    expect(sut.buckets.map((b) => b.name)).toEqual(['domain', 'application', 'adapters', 'infra']);
  });
});

describe('parseReport', () => {
  it('Given a report with schemaVersion 1.0, When parsed, Then returns it', () => {
    // Arrange
    const raw = { ...REPORT_BASE, files: {} };

    // Act
    const sut = parseReport(raw);

    // Assert
    expect(sut.schemaVersion).toBe('1.0');
  });

  it('Given a report missing schemaVersion, When parsed, Then throws', () => {
    // Arrange
    const raw = { files: {}, thresholds: REPORT_BASE.thresholds };

    // Act + Assert
    // Assert
    expect(() => parseReport(raw)).toThrowError(/report invalid: missing schemaVersion/);
  });

  it('Given a report with schemaVersion 99.0, When parsed, Then throws with unsupported-version message', () => {
    // Arrange
    const raw = { ...REPORT_BASE, schemaVersion: '99.0', files: {} };

    // Act + Assert
    // Assert
    expect(() => parseReport(raw)).toThrowError(/unsupported mutation-report schemaVersion: 99\.0/);
  });

  it('Given a report missing files, When parsed, Then throws', () => {
    // Arrange
    const raw = { ...REPORT_BASE };

    // Act + Assert
    // Assert
    expect(() => parseReport(raw)).toThrowError(/report invalid: missing files object/);
  });

  it('Given a report file with a Pending mutant, When parsed, Then throws (incomplete report)', () => {
    // Arrange
    const raw = {
      ...REPORT_BASE,
      files: { 'src/x.ts': fileResult(['Killed', 'Pending']) },
    };

    // Act + Assert
    // Assert
    expect(() => parseReport(raw)).toThrowError(
      /report invalid: file "src\/x\.ts" has Pending mutant/,
    );
  });

  it('Given a report with an unknown mutant status, When parsed, Then throws (schema-drift sentinel)', () => {
    // Arrange — Stryker may add new statuses in a future major; the parser
    // must fail loudly rather than silently drop them and let `total` diverge
    // from the sum of named fields.
    const raw = {
      ...REPORT_BASE,
      files: { 'src/x.ts': fileResult(['Killed', 'Hyperkilled']) },
    };

    // Act + Assert
    // Assert
    expect(() => parseReport(raw)).toThrowError(
      /report invalid: file "src\/x\.ts" has unknown mutant status "Hyperkilled"/,
    );
  });
});

describe('bucketForPath', () => {
  const buckets: readonly BucketDefinition[] = VALID_MANIFEST.buckets;

  it('Given src/domain/objects/blob.ts and the canonical manifest, When looked up, Then returns domain', () => {
    // Arrange
    // Act
    const sut = bucketForPath('src/domain/objects/blob.ts', buckets);

    // Assert
    expect(sut).toBe('domain');
  });

  it('Given src/repository.ts and the canonical manifest, When looked up, Then returns application', () => {
    // Arrange
    // Act
    const sut = bucketForPath('src/repository.ts', buckets);

    // Assert
    expect(sut).toBe('application');
  });

  it('Given a path matching no glob, When looked up, Then returns null', () => {
    // Arrange
    // Act
    const sut = bucketForPath('src/notabucket/foo.ts', buckets);

    // Assert
    expect(sut).toBeNull();
  });

  it('Given overlapping globs (synthetic manifest), When looked up, Then first-in-manifest-order wins', () => {
    // Arrange
    const overlapping: readonly BucketDefinition[] = [
      { name: 'domain', globs: ['src/a/**'], thresholds: { high: 100, low: 95, break: 90 } },
      { name: 'application', globs: ['src/a/**'], thresholds: { high: 100, low: 95, break: 90 } },
    ];

    // Act
    const sut = bucketForPath('src/a/x.ts', overlapping);

    // Assert
    expect(sut).toBe('domain');
  });
});

describe('evaluateBudgets', () => {
  const manifest = parseManifest(structuredClone(VALID_MANIFEST));

  it('Given an empty report, When evaluated, Then every bucket is n/a and ok is true', () => {
    // Arrange
    const report = parseReport({ ...REPORT_BASE, files: {} });

    // Act
    const sut = evaluateBudgets(report, manifest);

    // Assert
    expect(sut.ok).toBe(true);
    expect(sut.results).toHaveLength(4);
    expect(sut.results.every((r) => r.status === 'n/a')).toBe(true);
    expect(sut.unassignedFiles).toEqual([]);
    expect(sut.overlaps).toEqual([]);
  });

  it('Given one domain file with all mutants killed, When evaluated, Then domain passes at 100 and others are n/a', () => {
    // Arrange
    const report = parseReport({
      ...REPORT_BASE,
      files: {
        'src/domain/objects/blob.ts': fileResult(['Killed', 'Killed', 'Killed']),
      },
    });

    // Act
    const sut = evaluateBudgets(report, manifest);

    // Assert
    expect(sut.ok).toBe(true);
    const domain = sut.results.find((r) => r.bucket === 'domain');
    expect(domain).toMatchObject({ status: 'pass', score: 100, fileCount: 1 });
    expect(domain?.mutants).toMatchObject({ total: 3, killed: 3, survived: 0 });
    expect(sut.results.filter((r) => r.bucket !== 'domain').every((r) => r.status === 'n/a')).toBe(
      true,
    );
  });

  it('Given an adapters file at 80% killed (below 85 break), When evaluated, Then ok is false and adapters fails', () => {
    // Arrange — 4 killed of 5 = 80%
    const report = parseReport({
      ...REPORT_BASE,
      files: {
        'src/adapters/node/foo.ts': fileResult([
          'Killed',
          'Killed',
          'Killed',
          'Killed',
          'Survived',
        ]),
      },
    });

    // Act
    const sut = evaluateBudgets(report, manifest);

    // Assert
    expect(sut.ok).toBe(false);
    const adapters = sut.results.find((r) => r.bucket === 'adapters');
    expect(adapters).toMatchObject({ status: 'fail', score: 80, threshold: 85 });
  });

  it('Given an adapters file at exactly 85% killed, When evaluated, Then adapters passes (>= boundary)', () => {
    // Arrange — 17 killed of 20 = 85%
    const statuses = [
      ...Array.from({ length: 17 }, () => 'Killed'),
      'Survived',
      'Survived',
      'Survived',
    ];
    const report = parseReport({
      ...REPORT_BASE,
      files: { 'src/adapters/node/foo.ts': fileResult(statuses) },
    });

    // Act
    const sut = evaluateBudgets(report, manifest);

    // Assert
    expect(sut.ok).toBe(true);
    const adapters = sut.results.find((r) => r.bucket === 'adapters');
    expect(adapters).toMatchObject({ status: 'pass', score: 85, threshold: 85 });
  });

  it('Given a file matching no bucket, When evaluated, Then unassignedFiles surfaces it and ok is false', () => {
    // Arrange
    const report = parseReport({
      ...REPORT_BASE,
      files: { 'src/orphan/foo.ts': fileResult(['Killed']) },
    });

    // Act
    const sut = evaluateBudgets(report, manifest);

    // Assert
    expect(sut.ok).toBe(false);
    expect(sut.unassignedFiles).toEqual(['src/orphan/foo.ts']);
  });

  it('Given overlapping bucket globs, When evaluated, Then overlaps surfaces and ok is false', () => {
    // Arrange
    const overlappingManifest = parseManifest({
      buckets: [
        { name: 'domain', globs: ['src/x/**'], thresholds: { high: 100, low: 95, break: 90 } },
        { name: 'application', globs: ['src/x/**'], thresholds: { high: 100, low: 95, break: 90 } },
      ],
    });
    const report = parseReport({
      ...REPORT_BASE,
      files: { 'src/x/foo.ts': fileResult(['Killed']) },
    });

    // Act
    const sut = evaluateBudgets(report, overlappingManifest);

    // Assert
    expect(sut.ok).toBe(false);
    expect(sut.overlaps).toEqual([{ path: 'src/x/foo.ts', buckets: ['domain', 'application'] }]);
  });

  it('Given a domain file with mixed mutant statuses, When evaluated, Then score uses killed/(killed+survived+timeout+noCoverage)', () => {
    // Arrange — 8 killed, 1 survived, 1 noCoverage, 0 timeout, plus 1 Ignored (excluded), 1 CompileError (excluded)
    const statuses = [
      'Killed',
      'Killed',
      'Killed',
      'Killed',
      'Killed',
      'Killed',
      'Killed',
      'Killed',
      'Survived',
      'NoCoverage',
      'Ignored',
      'CompileError',
    ];
    const report = parseReport({
      ...REPORT_BASE,
      files: { 'src/domain/foo.ts': fileResult(statuses) },
    });

    // Act
    const sut = evaluateBudgets(report, manifest);

    // Assert — 8 / (8+1+1+0) = 80
    const domain = sut.results.find((r) => r.bucket === 'domain');
    expect(domain).toMatchObject({
      score: 80,
      mutants: { total: 12, killed: 8, survived: 1, noCoverage: 1, timeout: 0, ignored: 1 },
    });
    expect(sut.ok).toBe(false); // 80 < 99 break for domain
  });

  it('Given multiple buckets each with a file, When evaluated, Then per-bucket aggregation is independent', () => {
    // Arrange
    const report = parseReport({
      ...REPORT_BASE,
      files: {
        'src/domain/a.ts': fileResult(['Killed', 'Killed', 'Killed', 'Killed']),
        'src/application/b.ts': fileResult(['Killed', 'Killed', 'Killed', 'Killed', 'Survived']), // 80%
        'src/adapters/node/c.ts': fileResult(['Killed', 'Killed']), // 100%
      },
    });

    // Act
    const sut = evaluateBudgets(report, manifest);

    // Assert
    expect(sut.results.find((r) => r.bucket === 'domain')).toMatchObject({
      status: 'pass',
      score: 100,
    });
    expect(sut.results.find((r) => r.bucket === 'application')).toMatchObject({
      status: 'fail',
      score: 80,
      threshold: 95,
    });
    expect(sut.results.find((r) => r.bucket === 'adapters')).toMatchObject({
      status: 'pass',
      score: 100,
    });
    expect(sut.results.find((r) => r.bucket === 'infra')).toMatchObject({ status: 'n/a' });
    expect(sut.ok).toBe(false);
  });
});

// Ensure the imported StrykerMutationReport type is referenced (catches unused-import drift).
const _typeMarker: StrykerMutationReport = {
  schemaVersion: '1.0',
  thresholds: { high: 100, low: 95, break: 90 },
  files: {},
};
void _typeMarker;
