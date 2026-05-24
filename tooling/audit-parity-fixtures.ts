#!/usr/bin/env node
/**
 * Parity-fixtures determinism audit.
 *
 * Globs `test/parity/scenarios/**\/*.ts` and `test/parity/fixtures.ts`,
 * runs `detectNondeterministic` on every file, writes a JSON report to
 * `reports/parity-fixtures.json`, and exits non-zero if any finding is
 * emitted. Companion to the golden `commit.id` assertion: the lint catches
 * known non-determinism sources before they ever reach the SHA-1 step.
 */
import { glob, mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as process from 'node:process';

import {
  detectNondeterministic,
  type NondeterministicFinding,
  type SourceFile,
} from './parity-fixtures/detect-nondeterministic.ts';

const SCAN_GLOBS: ReadonlyArray<string> = [
  'test/parity/scenarios/**/*.ts',
  'test/parity/fixtures.ts',
];

const REPORT_PATH = 'reports/parity-fixtures.json';

const readFiles = async (
  root: string,
  patterns: ReadonlyArray<string>,
): Promise<ReadonlyArray<SourceFile>> => {
  const files: SourceFile[] = [];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    for await (const match of glob(pattern, { cwd: root })) {
      const relative = match.replaceAll(path.sep, '/');
      if (seen.has(relative)) continue;
      seen.add(relative);
      const absolute = path.join(root, match);
      const source = await readFile(absolute, 'utf8');
      files.push({ path: relative, source });
    }
  }
  return files;
};

const writeReport = async (
  root: string,
  findings: ReadonlyArray<NondeterministicFinding>,
): Promise<void> => {
  const absolute = path.join(root, REPORT_PATH);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, `${JSON.stringify({ findings }, null, 2)}\n`);
};

const formatFindings = (findings: ReadonlyArray<NondeterministicFinding>): string =>
  findings
    .map((finding) => `  ${finding.path}:${finding.line} — ${finding.kind}`)
    .join('\n');

const main = async (): Promise<void> => {
  const root = process.cwd();
  const files = await readFiles(root, SCAN_GLOBS);
  const findings = detectNondeterministic(files);
  await writeReport(root, findings);
  if (findings.length === 0) {
    process.stdout.write(`parity-fixtures: 0 findings across ${files.length} files\n`);
    return;
  }
  process.stderr.write(
    `parity-fixtures: ${findings.length} finding(s):\n${formatFindings(findings)}\n`,
  );
  process.exit(1);
};

await main();
