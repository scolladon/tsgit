/**
 * Per-bucket mutation-budget evaluator (Phase 19.1).
 *
 * Pure functions only. I/O lives in `scripts/check-mutation-budgets.ts`.
 * See `docs/design/phase-19-1-mutation-pyramid.md`.
 */
import { minimatch } from 'minimatch';

export type BucketName = 'domain' | 'application' | 'adapters' | 'infra';
const BUCKET_NAMES: readonly BucketName[] = ['domain', 'application', 'adapters', 'infra'];

export interface Thresholds {
  readonly high: number;
  readonly low: number;
  readonly break: number;
}

export interface BucketDefinition {
  readonly name: BucketName;
  readonly globs: readonly string[];
  readonly thresholds: Thresholds;
}

export interface BucketResult {
  readonly bucket: BucketName;
  readonly fileCount: number;
  readonly mutants: {
    readonly total: number;
    readonly killed: number;
    readonly survived: number;
    readonly noCoverage: number;
    readonly timeout: number;
    readonly ignored: number;
    readonly compileError: number;
    readonly runtimeError: number;
  };
  readonly score: number;
  readonly threshold: number;
  readonly status: 'pass' | 'fail' | 'n/a';
}

export interface BucketOverlap {
  readonly path: string;
  readonly buckets: readonly BucketName[];
}

export interface BudgetCheckOutcome {
  readonly results: readonly BucketResult[];
  readonly unassignedFiles: readonly string[];
  readonly overlaps: readonly BucketOverlap[];
  readonly ok: boolean;
}

export interface StrykerMutantResult {
  readonly id: string;
  readonly status: string;
}

export interface StrykerFileResult {
  readonly language: string;
  readonly source: string;
  readonly mutants: readonly StrykerMutantResult[];
}

export interface StrykerMutationReport {
  readonly schemaVersion: string;
  readonly thresholds: Thresholds;
  readonly files: { readonly [path: string]: StrykerFileResult };
}

export interface ParsedManifest {
  readonly buckets: readonly BucketDefinition[];
}

const SUPPORTED_SCHEMA_MAJOR = 1;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isThresholds = (raw: unknown): raw is Thresholds => {
  if (!isRecord(raw)) return false;
  for (const key of ['high', 'low', 'break'] as const) {
    const value = raw[key];
    if (typeof value !== 'number' || value < 0 || value > 100) return false;
  }
  return true;
};

export const parseManifest = (raw: unknown): ParsedManifest => {
  if (!isRecord(raw) || !('buckets' in raw)) {
    throw new Error('manifest invalid: missing buckets array');
  }
  const buckets = raw.buckets;
  if (!Array.isArray(buckets)) {
    throw new Error('manifest invalid: missing buckets array');
  }
  if (buckets.length === 0) {
    throw new Error('manifest invalid: buckets array must not be empty');
  }

  const validated: BucketDefinition[] = [];
  buckets.forEach((bucket: unknown, index: number) => {
    if (!isRecord(bucket)) {
      throw new Error(`manifest invalid: bucket[${index}] is not an object`);
    }
    if (!('name' in bucket) || typeof bucket.name !== 'string') {
      throw new Error(`manifest invalid: bucket[${index}] missing name`);
    }
    if (!BUCKET_NAMES.includes(bucket.name as BucketName)) {
      throw new Error(`manifest invalid: bucket[${index}] unknown name "${bucket.name}"`);
    }
    const name = bucket.name as BucketName;
    if (!('globs' in bucket) || !Array.isArray(bucket.globs)) {
      throw new Error(`manifest invalid: bucket[${index}] "${name}" globs must be an array`);
    }
    const globs = bucket.globs;
    if (globs.length === 0) {
      throw new Error(`manifest invalid: bucket[${index}] "${name}" globs must not be empty`);
    }
    globs.forEach((g: unknown, gIndex: number) => {
      if (typeof g !== 'string' || g.length === 0) {
        throw new Error(`manifest invalid: bucket[${index}] "${name}" glob[${gIndex}] must be a non-empty string`);
      }
    });
    if (!('thresholds' in bucket) || !isRecord(bucket.thresholds)) {
      throw new Error(`manifest invalid: bucket[${index}] "${name}" missing thresholds`);
    }
    const rawThresholds = bucket.thresholds;
    const thresholdValues: { high: number; low: number; break: number } = {
      high: 0,
      low: 0,
      break: 0,
    };
    for (const key of ['high', 'low', 'break'] as const) {
      const value = rawThresholds[key];
      if (typeof value !== 'number') {
        throw new Error(`manifest invalid: bucket[${index}] "${name}" threshold ${key} missing or not a number`);
      }
      if (value < 0 || value > 100) {
        throw new Error(`manifest invalid: bucket[${index}] "${name}" threshold ${key} out of range (got ${value})`);
      }
      thresholdValues[key] = value;
    }
    validated.push({
      name,
      globs: globs as readonly string[],
      thresholds: thresholdValues,
    });
  });

  return { buckets: validated };
};

export const parseReport = (raw: unknown): StrykerMutationReport => {
  if (!isRecord(raw)) {
    throw new Error('report invalid: not an object');
  }
  if (!('schemaVersion' in raw) || typeof raw.schemaVersion !== 'string') {
    throw new Error('report invalid: missing schemaVersion');
  }
  const major = raw.schemaVersion.split('.')[0];
  if (Number.parseInt(major ?? '', 10) !== SUPPORTED_SCHEMA_MAJOR) {
    throw new Error(`unsupported mutation-report schemaVersion: ${raw.schemaVersion}`);
  }
  if (!('files' in raw) || !isRecord(raw.files)) {
    throw new Error('report invalid: missing files object');
  }
  const validatedFiles: { [path: string]: StrykerFileResult } = {};
  for (const [path, fileResult] of Object.entries(raw.files)) {
    if (!isRecord(fileResult) || !Array.isArray(fileResult.mutants)) {
      throw new Error(`report invalid: file "${path}" malformed`);
    }
    const mutants: StrykerMutantResult[] = [];
    fileResult.mutants.forEach((m: unknown) => {
      if (!isRecord(m) || typeof m.status !== 'string') {
        throw new Error(`report invalid: file "${path}" mutant malformed`);
      }
      if (m.status === 'Pending') {
        throw new Error(`report invalid: file "${path}" has Pending mutant (incomplete run)`);
      }
      if (!KNOWN_MUTANT_STATUSES.has(m.status)) {
        throw new Error(
          `report invalid: file "${path}" has unknown mutant status "${m.status}" (parser needs update for new Stryker statuses)`,
        );
      }
      mutants.push({
        id: typeof m.id === 'string' ? m.id : String(m.id),
        status: m.status,
      });
    });
    validatedFiles[path] = {
      language: typeof fileResult.language === 'string' ? fileResult.language : 'typescript',
      source: typeof fileResult.source === 'string' ? fileResult.source : '',
      mutants,
    };
  }
  const thresholds = isThresholds(raw.thresholds)
    ? raw.thresholds
    : { high: 100, low: 95, break: 90 };
  return {
    schemaVersion: raw.schemaVersion,
    thresholds,
    files: validatedFiles,
  };
};

export const bucketForPath = (
  path: string,
  buckets: readonly BucketDefinition[],
): BucketName | null => {
  for (const bucket of buckets) {
    for (const pattern of bucket.globs) {
      if (minimatch(path, pattern)) return bucket.name;
    }
  }
  return null;
};

const allBucketsForPath = (
  path: string,
  buckets: readonly BucketDefinition[],
): readonly BucketName[] => {
  const matches: BucketName[] = [];
  for (const bucket of buckets) {
    for (const pattern of bucket.globs) {
      if (minimatch(path, pattern)) {
        matches.push(bucket.name);
        break;
      }
    }
  }
  return matches;
};

interface MutantTally {
  readonly total: number;
  readonly killed: number;
  readonly survived: number;
  readonly noCoverage: number;
  readonly timeout: number;
  readonly ignored: number;
  readonly compileError: number;
  readonly runtimeError: number;
}

const emptyTally = (): MutantTally => ({
  total: 0,
  killed: 0,
  survived: 0,
  noCoverage: 0,
  timeout: 0,
  ignored: 0,
  compileError: 0,
  runtimeError: 0,
});

type CountedField = keyof Omit<MutantTally, 'total'>;

const STATUS_TO_FIELD: Readonly<Record<string, CountedField>> = {
  Killed: 'killed',
  Survived: 'survived',
  NoCoverage: 'noCoverage',
  Timeout: 'timeout',
  Ignored: 'ignored',
  CompileError: 'compileError',
  RuntimeError: 'runtimeError',
};

const KNOWN_MUTANT_STATUSES: ReadonlySet<string> = new Set(Object.keys(STATUS_TO_FIELD));

const tallyMutants = (acc: MutantTally, file: StrykerFileResult): MutantTally => {
  const counted = file.mutants.reduce(
    (carry, m) => {
      // parseReport rejects unknown statuses, so STATUS_TO_FIELD[m.status] is
      // always defined here. The `?? carry` short-circuit is a no-op kept as
      // a type-narrowing aid.
      const key = STATUS_TO_FIELD[m.status];
      if (key === undefined) return carry;
      return { ...carry, [key]: carry[key] + 1 };
    },
    {
      killed: acc.killed,
      survived: acc.survived,
      noCoverage: acc.noCoverage,
      timeout: acc.timeout,
      ignored: acc.ignored,
      compileError: acc.compileError,
      runtimeError: acc.runtimeError,
    },
  );
  return {
    total: acc.total + file.mutants.length,
    killed: counted.killed,
    survived: counted.survived,
    noCoverage: counted.noCoverage,
    timeout: counted.timeout,
    ignored: counted.ignored,
    compileError: counted.compileError,
    runtimeError: counted.runtimeError,
  };
};

const computeScore = (tally: MutantTally): number => {
  const denom = tally.killed + tally.survived + tally.noCoverage + tally.timeout;
  if (denom === 0) return Number.NaN;
  return (tally.killed / denom) * 100;
};

interface BucketAggregate {
  readonly files: number;
  readonly tally: MutantTally;
}

export const evaluateBudgets = (
  report: StrykerMutationReport,
  manifest: ParsedManifest,
): BudgetCheckOutcome => {
  const perBucket: Map<BucketName, BucketAggregate> = new Map();
  for (const bucket of manifest.buckets) {
    perBucket.set(bucket.name, { files: 0, tally: emptyTally() });
  }
  const unassignedFiles: string[] = [];
  const overlaps: BucketOverlap[] = [];

  for (const [path, fileResult] of Object.entries(report.files)) {
    const matches = allBucketsForPath(path, manifest.buckets);
    if (matches.length === 0) {
      unassignedFiles.push(path);
      continue;
    }
    if (matches.length > 1) {
      overlaps.push({ path, buckets: matches });
    }
    const first = matches[0];
    if (first === undefined) continue;
    const slot = perBucket.get(first);
    if (slot === undefined) continue;
    perBucket.set(first, {
      files: slot.files + 1,
      tally: tallyMutants(slot.tally, fileResult),
    });
  }

  const results: BucketResult[] = manifest.buckets.map((bucket) => {
    const slot = perBucket.get(bucket.name);
    if (slot === undefined || slot.files === 0) {
      return {
        bucket: bucket.name,
        fileCount: 0,
        mutants: emptyTally(),
        score: Number.NaN,
        threshold: bucket.thresholds.break,
        status: 'n/a' as const,
      };
    }
    const score = computeScore(slot.tally);
    const status = Number.isNaN(score) ? 'n/a' : score >= bucket.thresholds.break ? 'pass' : 'fail';
    return {
      bucket: bucket.name,
      fileCount: slot.files,
      mutants: slot.tally,
      score,
      threshold: bucket.thresholds.break,
      status,
    };
  });

  const ok =
    unassignedFiles.length === 0 &&
    overlaps.length === 0 &&
    results.every((r) => r.status !== 'fail');

  return { results, unassignedFiles, overlaps, ok };
};
