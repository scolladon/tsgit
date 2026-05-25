import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'tooling', 'audit-write-surfaces.ts');

interface CliRun {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

const runScript = async (
  root: string,
  extraArgs: ReadonlyArray<string> = [],
): Promise<CliRun> => {
  const outDir = path.join(root, 'out');
  try {
    const { stdout, stderr } = await execFileAsync('node', [
      '--experimental-strip-types',
      SCRIPT,
      '--root',
      root,
      '--out',
      outDir,
      '--allowlist',
      path.join(root, 'allowlist.json'),
      ...extraArgs,
    ]);
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
  }
};

const stageRoot = async (root: string): Promise<void> => {
  await mkdir(path.join(root, 'src', 'domain'), { recursive: true });
  await mkdir(path.join(root, 'test', 'integration'), { recursive: true });
  await mkdir(path.join(root, 'tooling'), { recursive: true });
};

const writeAllowlist = async (root: string, body: unknown): Promise<void> => {
  await writeFile(path.join(root, 'allowlist.json'), JSON.stringify(body, null, 2));
};

const writeWritesSrc = async (
  root: string,
  relPath: string,
  surface: string,
  kind = 'byte-identical',
): Promise<void> => {
  const body = `/**
 * Stub module.
 *
 * @writes
 *   surface: ${surface}
 *   kind:    ${kind}
 *   format:  git-${surface}
 */
export const stub = 1;
`;
  await writeFile(path.join(root, relPath), body);
};

const writeInteropTest = async (
  root: string,
  relPath: string,
  surface: string,
): Promise<void> => {
  const body = `/**
 * @proves
 *   surface:        ${surface}
 *   bucket:         cross-tool-interop
 *   unique:         round-trips against canonical git for ${surface}
 *   interopSurface: ${surface}
 */
import { describe, it } from 'vitest';
describe('${surface}', () => { it('round-trips', () => {}); });
`;
  await writeFile(path.join(root, relPath), body);
};

const readReport = async (root: string): Promise<Record<string, unknown>> => {
  const raw = await readFile(path.join(root, 'out', 'write-surface-coverage.json'), 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
};

describe('tooling/audit-write-surfaces (integration)', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'write-surface-audit-'));
    await stageRoot(tmpRoot);
    await writeAllowlist(tmpRoot, { surfaces: [] });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  describe('Given every declared surface has matching interop coverage', () => {
    describe('When the audit runs', () => {
      it('Then exit is 0 and the report has zero findings', async () => {
        // Arrange
        await writeWritesSrc(tmpRoot, 'src/domain/tree.ts', 'tree');
        await writeInteropTest(tmpRoot, 'test/integration/tree-interop.test.ts', 'tree');

        // Act
        const sut = await runScript(tmpRoot);

        // Assert
        expect(sut.code).toBe(0);
        expect(sut.stdout).toMatch(/clean/);
        const report = await readReport(tmpRoot);
        expect(report['summary']).toMatchObject({
          declared: 1,
          covered: 1,
          gaps: 0,
          malformed: 0,
        });
      });
    });
  });

  describe('Given a declared surface without any covering test', () => {
    describe('When the audit runs warn-only', () => {
      it('Then exit is 0 but stderr lists the gap', async () => {
        // Arrange
        await writeWritesSrc(tmpRoot, 'src/domain/tree.ts', 'tree');

        // Act
        const sut = await runScript(tmpRoot);

        // Assert
        expect(sut.code).toBe(0);
        expect(sut.stderr).toContain('tree');
        expect(sut.stderr).toContain('warn-only');
        const report = await readReport(tmpRoot);
        expect(report['summary']).toMatchObject({ declared: 1, gaps: 1 });
      });
    });

    describe('When the audit runs with --blocking', () => {
      it('Then exit is 1 and stderr lists the gap', async () => {
        // Arrange
        await writeWritesSrc(tmpRoot, 'src/domain/tree.ts', 'tree');

        // Act
        const sut = await runScript(tmpRoot, ['--blocking']);

        // Assert
        expect(sut.code).toBe(1);
        expect(sut.stderr).toContain('tree');
        expect(sut.stderr).not.toContain('warn-only');
      });
    });
  });

  describe('Given a cross-tool-interop test missing the interopSurface key', () => {
    describe('When the audit runs', () => {
      it('Then the test is reported in malformed', async () => {
        // Arrange
        const body = `/**
 * @proves
 *   surface: tree
 *   bucket:  cross-tool-interop
 *   unique:  something specific to test
 */
`;
        await writeFile(path.join(tmpRoot, 'test/integration/bad.test.ts'), body);

        // Act
        const sut = await runScript(tmpRoot);

        // Assert
        const report = await readReport(tmpRoot);
        expect(report['summary']).toMatchObject({ malformed: 1 });
        const malformed = report['malformed'] as ReadonlyArray<{ detail: string }>;
        expect(malformed[0]?.detail).toContain('missing-interop-surface');
      });
    });
  });

  describe('Given an allowlist entry naming an undeclared surface', () => {
    describe('When the audit runs', () => {
      it('Then the entry is reported under allowlistRot', async () => {
        // Arrange
        await writeAllowlist(tmpRoot, {
          surfaces: [{ surface: 'staleName', reason: 'old', deferredTo: null }],
        });

        // Act
        const sut = await runScript(tmpRoot);

        // Assert
        const report = await readReport(tmpRoot);
        expect(report['allowlistRot']).toEqual(['staleName']);
        expect(sut.stderr).toContain('staleName');
      });
    });
  });

  describe('Given an interop test naming a surface no @writes declares', () => {
    describe('When the audit runs', () => {
      it('Then the test is reported under orphanCoverage', async () => {
        // Arrange
        await writeInteropTest(tmpRoot, 'test/integration/orphan-interop.test.ts', 'unbacked');

        // Act
        const sut = await runScript(tmpRoot);

        // Assert
        const report = await readReport(tmpRoot);
        const orphan = report['orphanCoverage'] as ReadonlyArray<{ surface: string }>;
        expect(orphan.map((o) => o.surface)).toContain('unbacked');
        expect(sut.stderr).toContain('unbacked');
      });
    });
  });

  describe('Given a malformed @writes block in src', () => {
    describe('When the audit runs', () => {
      it('Then the src file is reported in malformed', async () => {
        // Arrange
        const body = `/**
 * @writes
 *   surface: tree
 *   format:  git-tree-object
 */
`;
        await writeFile(path.join(tmpRoot, 'src/domain/broken.ts'), body);

        // Act
        const sut = await runScript(tmpRoot);

        // Assert
        expect(sut.code).toBe(0);
        const report = await readReport(tmpRoot);
        const malformed = report['malformed'] as ReadonlyArray<{ kind: string; detail: string }>;
        expect(malformed[0]?.kind).toBe('src-malformed');
        expect(malformed[0]?.detail).toContain('missing-key');
      });
    });
  });
});
