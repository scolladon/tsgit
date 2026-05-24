/**
 * Integration-test usefulness detector.
 *
 * Reads `@proves` headers from integration test files and emits three
 * disjoint finding classes per ADR-124:
 *
 *   missing   — header absent or grammar-invalid
 *   duplicate — two files claim the same `(surface, bucket)` pair without
 *               the platform-only exemption (ADR-123)
 *   misplaced — bucket's directoryRules forbid the file's directory class
 *
 * Pure function. Caller owns I/O.
 */
import { classifyTestFile } from './classify-test-file.ts';
import {
  parseProvesHeader,
  type ProvesError,
  type ProvesHeader,
} from './parse-proves-header.ts';
import type { DirectoryClass, PyramidManifest } from './parse-manifest.ts';
import type { SourceFile } from './types.ts';

export interface MissingFinding {
  readonly path: string;
  readonly reason: ProvesError['reason'];
  readonly detail?: string;
}

export interface DuplicateFinding {
  readonly surface: string;
  readonly bucket: string;
  readonly paths: ReadonlyArray<string>;
}

export interface MisplacedFinding {
  readonly path: string;
  readonly bucket: string;
  readonly actual: DirectoryClass;
  readonly expected: ReadonlyArray<DirectoryClass>;
}

export interface IntegrationProofFindings {
  readonly missing: ReadonlyArray<MissingFinding>;
  readonly duplicate: ReadonlyArray<DuplicateFinding>;
  readonly misplaced: ReadonlyArray<MisplacedFinding>;
  readonly accepted: ReadonlyArray<AcceptedRecord>;
}

export interface AcceptedRecord {
  readonly path: string;
  readonly surface: string;
  readonly bucket: string;
  readonly unique: string;
  readonly directory: DirectoryClass;
}

const PLATFORM_BUCKET = 'platform-only';

export const classifyDirectory = (repoRelPath: string): DirectoryClass => {
  const normalised = repoRelPath.replace(/\\/g, '/');
  const parts = normalised.split('/');
  // test/integration/<bucket-folder?>/<file>
  // Directories that mean something to the audit live as the third segment.
  // Anything else collapses to `root` (mainline integration dir).
  const folder = parts[2];
  if (folder === 'network') return 'network/';
  if (folder === 'posix-only') return 'posix-only/';
  if (folder === 'win-only') return 'win-only/';
  return 'root';
};

const sortPaths = (paths: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const collectDuplicates = (
  parsed: ReadonlyArray<readonly [string, ProvesHeader]>,
): ReadonlyArray<DuplicateFinding> => {
  const byKey = new Map<string, { surface: string; bucket: string; paths: string[] }>();
  for (const [path, header] of parsed) {
    const key = `${header.surface}${header.bucket}`;
    const entry = byKey.get(key);
    if (entry === undefined) {
      byKey.set(key, { surface: header.surface, bucket: header.bucket, paths: [path] });
    } else {
      entry.paths.push(path);
    }
  }
  const findings: DuplicateFinding[] = [];
  for (const entry of byKey.values()) {
    if (entry.paths.length < 2) continue;
    if (entry.bucket === PLATFORM_BUCKET) {
      const allUnderPlatformDir = entry.paths.every((p) => {
        const dir = classifyDirectory(p);
        return dir === 'posix-only/' || dir === 'win-only/';
      });
      if (allUnderPlatformDir) continue;
    }
    findings.push({
      surface: entry.surface,
      bucket: entry.bucket,
      paths: sortPaths(entry.paths),
    });
  }
  findings.sort((a, b) => {
    if (a.surface !== b.surface) return a.surface < b.surface ? -1 : 1;
    return a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0;
  });
  return findings;
};

const computeMisplaced = (
  parsed: ReadonlyArray<readonly [string, ProvesHeader]>,
  manifest: PyramidManifest,
): ReadonlyArray<MisplacedFinding> => {
  const rules = manifest.heuristics.integrationProof.directoryRules;
  const out: MisplacedFinding[] = [];
  for (const [path, header] of parsed) {
    const expected = rules.get(header.bucket);
    if (expected === undefined) continue;
    const actual = classifyDirectory(path);
    if (!expected.includes(actual)) {
      out.push({ path, bucket: header.bucket, actual, expected });
    }
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
};

export const detectIntegrationProof = (
  manifest: PyramidManifest,
  files: ReadonlyArray<SourceFile>,
): IntegrationProofFindings => {
  const heuristic = manifest.heuristics.integrationProof;
  const integrationFiles = files.filter(
    (f) => classifyTestFile(manifest, f.path) === heuristic.tier,
  );

  const missing: MissingFinding[] = [];
  const parsed: Array<readonly [string, ProvesHeader]> = [];
  const accepted: AcceptedRecord[] = [];

  for (const file of integrationFiles) {
    const result = parseProvesHeader(file.source, heuristic);
    if (!result.ok) {
      const base: MissingFinding =
        result.error.detail === undefined
          ? { path: file.path, reason: result.error.reason }
          : { path: file.path, reason: result.error.reason, detail: result.error.detail };
      missing.push(base);
      continue;
    }
    parsed.push([file.path, result.header]);
    accepted.push({
      path: file.path,
      surface: result.header.surface,
      bucket: result.header.bucket,
      unique: result.header.unique,
      directory: classifyDirectory(file.path),
    });
  }

  missing.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  accepted.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    missing,
    duplicate: collectDuplicates(parsed),
    misplaced: computeMisplaced(parsed, manifest),
    accepted,
  };
};
