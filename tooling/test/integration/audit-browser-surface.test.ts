import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'tooling', 'audit-browser-surface.ts');

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
      ...extraArgs,
    ]);
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
  }
};

const REPOSITORY_STUB = [
  'interface Repository {',
  '  readonly add: BindCtx<typeof commands.add>;',
  '  readonly clone: BindCtx<typeof commands.clone>;',
  '  readonly primitives: {',
  '    readonly readObject: BindCtx<typeof primitives.readObject>;',
  '    readonly runHook: BindCtx<typeof primitives.runHook>;',
  '  };',
  '  readonly ctx: Context;',
  '  readonly dispose: () => Promise<void>;',
  '}',
  '',
].join('\n');

const stageRoot = async (root: string, repositorySource = REPOSITORY_STUB): Promise<void> => {
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'test', 'browser'), { recursive: true });
  await mkdir(path.join(root, 'test', 'parity', 'scenarios'), { recursive: true });
  await mkdir(path.join(root, 'tooling'), { recursive: true });
  await writeFile(path.join(root, 'src', 'repository.ts'), repositorySource);
};

const writeAllowlist = async (root: string, body: unknown): Promise<void> => {
  await writeFile(
    path.join(root, 'tooling', 'audit-browser-surface.allowlist.json'),
    JSON.stringify(body, null, 2),
  );
};

describe('tooling/audit-browser-surface (integration)', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'browser-surface-audit-'));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  describe('Given every bound surface is either covered or allowlisted', () => {
    describe('When the audit runs', () => {
      it('Then exit is 0 and the report has zero gaps', async () => {
        // Arrange
        await stageRoot(tmpRoot);
        await writeFile(
          path.join(tmpRoot, 'test', 'browser', 'one.spec.ts'),
          'await repo.add(["a.txt"]);\nawait repo.primitives.readObject(id);\n',
        );
        await writeAllowlist(tmpRoot, {
          commands: [{ name: 'clone', reason: 'no in-page server yet', deferredTo: '19.8' }],
          primitives: [{ name: 'runHook', reason: 'browser has no hook runner', deferredTo: null }],
        });

        // Act
        const sut = await runScript(tmpRoot);

        // Assert
        expect(sut.code).toBe(0);
        expect(sut.stdout).toMatch(/^audit-browser-surface: clean/);
        const report = JSON.parse(
          await readFile(path.join(tmpRoot, 'out', 'browser-surface-coverage.json'), 'utf8'),
        );
        expect(report.summary.commands).toEqual({ bound: 2, covered: 1, exempt: 1, gaps: 0 });
        expect(report.summary.primitives).toEqual({ bound: 2, covered: 1, exempt: 1, gaps: 0 });
        expect(report.gaps).toEqual({ commands: [], primitives: [] });
      });
    });
  });

  describe('Given a bound command without coverage or allowlisting', () => {
    describe('When the audit runs', () => {
      it('Then exit is 1 and the gap is reported on stderr', async () => {
        // Arrange
        await stageRoot(tmpRoot);
        await writeFile(
          path.join(tmpRoot, 'test', 'browser', 'one.spec.ts'),
          'await repo.add(["a.txt"]);\nawait repo.primitives.readObject(id);\n',
        );
        await writeAllowlist(tmpRoot, {
          commands: [],
          primitives: [{ name: 'runHook', reason: 'browser has no hook runner', deferredTo: null }],
        });

        // Act
        const sut = await runScript(tmpRoot);

        // Assert
        expect(sut.code).toBe(1);
        expect(sut.stderr).toContain('Commands without browser coverage:');
        expect(sut.stderr).toContain('  - repo.clone');
        expect(sut.stderr).toMatch(/audit-browser-surface: 1 gap\(s\) found/);
        const report = JSON.parse(
          await readFile(path.join(tmpRoot, 'out', 'browser-surface-coverage.json'), 'utf8'),
        );
        expect(report.gaps.commands).toEqual(['clone']);
        // Lock that the gap is restricted to the commands tier — a mutation
        // that incorrectly populated `gaps.primitives` would otherwise be
        // invisible because the test prints only the commands assertion.
        expect(report.gaps.primitives).toEqual([]);
      });
    });
  });

  describe('Given a parity scenario covers a primitive', () => {
    describe('When the audit runs', () => {
      it('Then the primitive is reported as covered with the scenario as a source', async () => {
        // Arrange
        await stageRoot(tmpRoot);
        await writeFile(
          path.join(tmpRoot, 'test', 'parity', 'scenarios', 'r.scenario.ts'),
          'await repo.add([]);\nawait repo.primitives.readObject(id);\n',
        );
        await writeAllowlist(tmpRoot, {
          commands: [{ name: 'clone', reason: 'transport defer', deferredTo: '19.8' }],
          primitives: [{ name: 'runHook', reason: 'no hooks', deferredTo: null }],
        });

        // Act
        const sut = await runScript(tmpRoot);

        // Assert
        expect(sut.code).toBe(0);
        const report = JSON.parse(
          await readFile(path.join(tmpRoot, 'out', 'browser-surface-coverage.json'), 'utf8'),
        );
        const covered = report.covered.primitives.find(
          (entry: { name: string }) => entry.name === 'readObject',
        );
        expect(covered).toBeDefined();
        expect(covered.sources).toEqual(['test/parity/scenarios/r.scenario.ts']);
      });
    });
  });

  describe('Given a malformed allowlist file', () => {
    describe('When the audit runs', () => {
      it('Then exit is 1 and stderr names the failing entry', async () => {
        // Arrange
        await stageRoot(tmpRoot);
        await writeAllowlist(tmpRoot, {
          commands: [{ name: 'clone', reason: '', deferredTo: null }],
          primitives: [],
        });

        // Act
        const sut = await runScript(tmpRoot);

        // Assert
        expect(sut.code).toBe(1);
        expect(sut.stderr).toContain('allowlist.commands[0]: malformed entry');
      });
    });
  });

  describe('Given an allowlist entry naming a removed surface', () => {
    describe('When the audit runs', () => {
      it('Then exit is 1 and stderr identifies the stale entry', async () => {
        // Arrange
        await stageRoot(tmpRoot);
        await writeAllowlist(tmpRoot, {
          commands: [{ name: 'removedCommand', reason: 'r', deferredTo: null }],
          primitives: [],
        });

        // Act
        const sut = await runScript(tmpRoot);

        // Assert
        expect(sut.code).toBe(1);
        expect(sut.stderr).toContain(
          "allowlist.commands: 'removedCommand' is not currently bound",
        );
      });
    });
  });

  describe('Given an unknown CLI flag', () => {
    describe('When the audit runs', () => {
      it('Then exit is 1 with a "unknown flag" message', async () => {
        // Arrange
        await stageRoot(tmpRoot);

        // Act
        const sut = await runScript(tmpRoot, ['--bogus']);

        // Assert
        expect(sut.code).toBe(1);
        expect(sut.stderr).toContain('unknown flag: --bogus');
      });
    });
  });

  describe('Given a src/repository.ts that the parser cannot recognise', () => {
    describe('When the audit runs', () => {
      it('Then exit is 1 with the refactor-warning message', async () => {
        // Arrange
        // Write a syntactically-trivial but valid allowlist first so the
        // failure cannot escape via the missing-allowlist path; the
        // intent is to isolate the parser-shape exit specifically.
        await stageRoot(tmpRoot, 'export const noop = () => undefined;\n');
        await writeAllowlist(tmpRoot, { commands: [], primitives: [] });

        // Act
        const sut = await runScript(tmpRoot);

        // Assert
        expect(sut.code).toBe(1);
        expect(sut.stderr).toContain('parser yielded zero commands AND zero primitives');
      });
    });
  });

  const NAMESPACE_STUB = [
    'interface Repository {',
    '  readonly add: BindCtx<typeof commands.add>;',
    '  readonly config: commands.ConfigNamespace;',
    '  readonly primitives: {',
    '    readonly readObject: BindCtx<typeof primitives.readObject>;',
    '    readonly runHook: BindCtx<typeof primitives.runHook>;',
    '  };',
    '  readonly ctx: Context;',
    '  readonly dispose: () => Promise<void>;',
    '}',
    '',
  ].join('\n');

  describe('Given a namespaced command bound and a dotted call site covering it', () => {
    describe('When the audit runs', () => {
      it('Then the namespace is reported covered and exit is 0', async () => {
        // Arrange
        await stageRoot(tmpRoot, NAMESPACE_STUB);
        await writeFile(
          path.join(tmpRoot, 'test', 'browser', 'one.spec.ts'),
          'await repo.add(["a.txt"]);\nawait repo.config.get({ key: "user.name" });\nawait repo.primitives.readObject(id);\n',
        );
        await writeAllowlist(tmpRoot, {
          commands: [],
          primitives: [{ name: 'runHook', reason: 'browser has no hook runner', deferredTo: null }],
        });

        // Act
        const sut = await runScript(tmpRoot);

        // Assert
        expect(sut.code).toBe(0);
        const report = JSON.parse(
          await readFile(path.join(tmpRoot, 'out', 'browser-surface-coverage.json'), 'utf8'),
        );
        const covered = report.covered.commands.find(
          (entry: { name: string }) => entry.name === 'config',
        );
        expect(covered).toBeDefined();
        expect(covered.sources).toEqual(['test/browser/one.spec.ts']);
        expect(report.gaps.commands).toEqual([]);
      });
    });
  });

  describe('Given a namespaced command bound with no dotted call site', () => {
    describe('When the audit runs', () => {
      it('Then the namespace is reported as a gap and exit is 1', async () => {
        // Arrange
        await stageRoot(tmpRoot, NAMESPACE_STUB);
        await writeFile(
          path.join(tmpRoot, 'test', 'browser', 'one.spec.ts'),
          'await repo.add(["a.txt"]);\nawait repo.primitives.readObject(id);\n',
        );
        await writeAllowlist(tmpRoot, {
          commands: [],
          primitives: [{ name: 'runHook', reason: 'browser has no hook runner', deferredTo: null }],
        });

        // Act
        const sut = await runScript(tmpRoot);

        // Assert — the namespace is now gate-enforced, not invisible.
        expect(sut.code).toBe(1);
        expect(sut.stderr).toContain('  - repo.config');
        const report = JSON.parse(
          await readFile(path.join(tmpRoot, 'out', 'browser-surface-coverage.json'), 'utf8'),
        );
        expect(report.gaps.commands).toEqual(['config']);
      });
    });
  });

  describe('Given a tree with no src/repository.ts', () => {
    describe('When the audit runs', () => {
      it('Then the unhandled rejection is converted into a friendly exit-1 error', async () => {
        // Arrange — skip stageRoot entirely so `src/repository.ts` is absent.
        await mkdir(path.join(tmpRoot, 'tooling'), { recursive: true });
        await writeAllowlist(tmpRoot, { commands: [], primitives: [] });

        // Act
        const sut = await runScript(tmpRoot);

        // Assert — must hit the .catch() in the runAudit dispatch, which
        // prefixes the message; a raw rethrow would still exit 1 but the
        // stderr would be a Node stack trace, not the prefixed line.
        expect(sut.code).toBe(1);
        expect(sut.stderr).toMatch(/^audit-browser-surface: /m);
        expect(sut.stderr).toContain('ENOENT');
      });
    });
  });
});
