import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as url from 'node:url';

import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { analyzeCallSites, type CallSite } from '../../audit-assert-tier/analyze-call-sites.ts';
import { computeFindings } from '../../audit-assert-tier/compute-findings.ts';
import {
  type AllowEntry,
  AllowlistError,
  parseAllowlist,
} from '../../audit-assert-tier/load-allowlist.ts';
import { runAudit } from '../../audit-assert-tier.ts';

const REPO_ROOT_REAL = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../..');
const SHIPPED_ALLOWLIST = path.join(REPO_ROOT_REAL, 'tooling', 'audit-assert-tier.allowlist.json');

const COMPILER_OPTIONS: ts.CompilerOptions = {
  allowJs: false,
  checkJs: false,
  declaration: false,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  target: ts.ScriptTarget.ES2022,
  skipLibCheck: true,
  noEmit: true,
};

const REPO_ROOT = '/virtual';
const TARGET_MODULE = '/virtual/src/application/primitives/internal/repo-state.ts';
const PRIMITIVES_SOURCE =
  'export const assertRepository = async (ctx: unknown): Promise<void> => {};\n';

/** Builds a real `ts.Program` over in-memory sources, falling back to the
 * real filesystem for everything else (lib.*.d.ts). Mirrors the compiler-API
 * precedent (`tooling/dts-value-exports.ts`), but virtualised for readable,
 * isolated fixtures. */
const buildProgram = (
  files: Readonly<Record<string, string>>,
): { readonly program: ts.Program; readonly filePaths: readonly string[] } => {
  const map = new Map(Object.entries(files));
  const baseHost = ts.createCompilerHost(COMPILER_OPTIONS, true);
  const host: ts.CompilerHost = {
    ...baseHost,
    fileExists: (fileName) => map.has(fileName) || baseHost.fileExists(fileName),
    readFile: (fileName) => map.get(fileName) ?? baseHost.readFile(fileName),
    directoryExists: (dir) =>
      [...map.keys()].some((f) => f.startsWith(`${dir}/`)) ||
      (baseHost.directoryExists?.(dir) ?? true),
    getDirectories: (dir) => baseHost.getDirectories?.(dir) ?? [],
    realpath: (p) => p,
    getSourceFile: (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
      const content = map.get(fileName);
      if (content !== undefined) {
        return ts.createSourceFile(fileName, content, ts.ScriptTarget.ES2022, true);
      }
      return baseHost.getSourceFile(
        fileName,
        languageVersionOrOptions,
        onError,
        shouldCreateNewSourceFile,
      );
    },
  };
  const filePaths = [...map.keys()];
  const program = ts.createProgram(filePaths, COMPILER_OPTIONS, host);
  return { program, filePaths };
};

const analyze = (files: Readonly<Record<string, string>>): readonly CallSite[] => {
  const { program, filePaths } = buildProgram(files);
  return analyzeCallSites(program, filePaths, REPO_ROOT, {
    targetModule: TARGET_MODULE,
    targetExportName: 'assertRepository',
  });
};

const expectAllowlistError = (fn: () => unknown, expectedReason: string): void => {
  try {
    fn();
    throw new Error('expected AllowlistError, got success');
  } catch (err) {
    expect(err).toBeInstanceOf(AllowlistError);
    if (err instanceof AllowlistError) {
      expect(err.reason).toBe(expectedReason);
    }
  }
};

describe('parseAllowlist', () => {
  describe('Given an empty callers array', () => {
    describe('When parsed', () => {
      it('Then returns an empty list', () => {
        // Arrange
        const sutContent = '{ "callers": [] }';

        // Act
        const result = parseAllowlist(sutContent);

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given one well-formed entry', () => {
    describe('When parsed', () => {
      it('Then returns the entry as an AllowEntry', () => {
        // Arrange
        const sutContent = JSON.stringify({
          callers: [
            { module: 'src/application/commands/config.ts', verb: 'configGet', reason: 'because' },
          ],
        });

        // Act
        const result = parseAllowlist(sutContent);

        // Assert
        expect(result).toEqual([
          { module: 'src/application/commands/config.ts', verb: 'configGet', reason: 'because' },
        ]);
      });
    });
  });

  describe('Given malformed JSON', () => {
    describe('When parsed', () => {
      it('Then throws AllowlistError with reason=invalid-json', () => {
        // Arrange
        const sutContent = '{ callers: not-json';

        // Act + Assert
        expectAllowlistError(() => parseAllowlist(sutContent), 'invalid-json');
      });
    });
  });

  describe('Given valid JSON that is not an object', () => {
    describe('When parsed', () => {
      it('Then throws AllowlistError with reason=not-an-object', () => {
        // Arrange
        const sutContent = '[]';

        // Act + Assert
        expectAllowlistError(() => parseAllowlist(sutContent), 'not-an-object');
      });
    });
  });

  describe('Given an object missing the callers array', () => {
    describe('When parsed', () => {
      it('Then throws AllowlistError with reason=missing-callers-array', () => {
        // Arrange
        const sutContent = '{ "other": [] }';

        // Act + Assert
        expectAllowlistError(() => parseAllowlist(sutContent), 'missing-callers-array');
      });
    });
  });

  describe('Given a callers field that is not an array', () => {
    describe('When parsed', () => {
      it('Then throws AllowlistError with reason=missing-callers-array', () => {
        // Arrange
        const sutContent = '{ "callers": "oops" }';

        // Act + Assert
        expectAllowlistError(() => parseAllowlist(sutContent), 'missing-callers-array');
      });
    });
  });

  describe('Given an entry that is not an object', () => {
    describe('When parsed', () => {
      it('Then throws AllowlistError with reason=entry-not-an-object', () => {
        // Arrange
        const sutContent = '{ "callers": ["plain-string"] }';

        // Act + Assert
        expectAllowlistError(() => parseAllowlist(sutContent), 'entry-not-an-object');
      });
    });
  });

  describe('Given an entry missing the module field', () => {
    describe('When parsed', () => {
      it('Then throws AllowlistError with reason=missing-field', () => {
        // Arrange
        const sutContent = JSON.stringify({
          callers: [{ verb: 'configGet', reason: 'because' }],
        });

        // Act + Assert
        expectAllowlistError(() => parseAllowlist(sutContent), 'missing-field');
      });
    });
  });

  describe('Given an entry missing the verb field', () => {
    describe('When parsed', () => {
      it('Then throws AllowlistError with reason=missing-field', () => {
        // Arrange
        const sutContent = JSON.stringify({
          callers: [{ module: 'src/application/commands/config.ts', reason: 'because' }],
        });

        // Act + Assert
        expectAllowlistError(() => parseAllowlist(sutContent), 'missing-field');
      });
    });
  });

  describe('Given an entry missing the reason field', () => {
    describe('When parsed', () => {
      it('Then throws AllowlistError with reason=missing-field', () => {
        // Arrange
        const sutContent = JSON.stringify({
          callers: [{ module: 'src/application/commands/config.ts', verb: 'configGet' }],
        });

        // Act + Assert
        expectAllowlistError(() => parseAllowlist(sutContent), 'missing-field');
      });
    });
  });

  describe('Given an entry with a non-string reason', () => {
    describe('When parsed', () => {
      it('Then throws AllowlistError with reason=wrong-field-type', () => {
        // Arrange
        const sutContent = JSON.stringify({
          callers: [
            { module: 'src/application/commands/config.ts', verb: 'configGet', reason: 42 },
          ],
        });

        // Act + Assert
        expectAllowlistError(() => parseAllowlist(sutContent), 'wrong-field-type');
      });
    });
  });

  describe('Given an entry with a whitespace-only reason', () => {
    describe('When parsed', () => {
      it('Then throws AllowlistError with reason=empty-string', () => {
        // Arrange
        const sutContent = JSON.stringify({
          callers: [
            { module: 'src/application/commands/config.ts', verb: 'configGet', reason: '   ' },
          ],
        });

        // Act + Assert
        expectAllowlistError(() => parseAllowlist(sutContent), 'empty-string');
      });
    });
  });
});

describe('analyzeCallSites + computeFindings', () => {
  describe('Given a module calling the bare assert from a non-allowlisted exported verb', () => {
    describe('When analyzed and compared against an empty allowlist', () => {
      it('Then the caller is reported unguarded with module, verb and line', () => {
        // Arrange
        const callSites = analyze({
          [TARGET_MODULE]: PRIMITIVES_SOURCE,
          '/virtual/src/application/commands/stash.ts': [
            "import { assertRepository } from '../primitives/internal/repo-state.js';",
            'export const stashList = async (ctx: unknown): Promise<void> => {',
            '  await assertRepository(ctx);',
            '};',
            '',
          ].join('\n'),
        });

        // Act
        const result = computeFindings(callSites, []);

        // Assert
        expect(result.unguarded).toEqual([
          { module: 'src/application/commands/stash.ts', verb: 'stashList', line: 3 },
        ]);
      });
    });
  });

  describe('Given the same call from an allowlisted verb', () => {
    describe('When analyzed and compared against a matching allowlist', () => {
      it('Then it is not reported unguarded', () => {
        // Arrange
        const callSites = analyze({
          [TARGET_MODULE]: PRIMITIVES_SOURCE,
          '/virtual/src/application/commands/stash.ts': [
            "import { assertRepository } from '../primitives/internal/repo-state.js';",
            'export const stashList = async (ctx: unknown): Promise<void> => {',
            '  await assertRepository(ctx);',
            '};',
            '',
          ].join('\n'),
        });
        const allowlist: readonly AllowEntry[] = [
          { module: 'src/application/commands/stash.ts', verb: 'stashList', reason: 'measured' },
        ];

        // Act
        const result = computeFindings(callSites, allowlist);

        // Assert
        expect(result.unguarded).toEqual([]);
      });
    });
  });

  describe('Given an allowlist entry matching no call site', () => {
    describe('When compared against an empty set of call sites', () => {
      it('Then the entry is reported as stale', () => {
        // Arrange
        const staleEntry: AllowEntry = {
          module: 'src/application/commands/config.ts',
          verb: 'configReadAll',
          reason: 'no longer exists',
        };

        // Act
        const result = computeFindings([], [staleEntry]);

        // Assert
        expect(result.stale).toEqual([staleEntry]);
      });
    });
  });

  describe('Given an aliased import of the bare assert', () => {
    describe('When analyzed', () => {
      it('Then the call is attributed by binding, not by the local alias name', () => {
        // Arrange
        const callSites = analyze({
          [TARGET_MODULE]: PRIMITIVES_SOURCE,
          '/virtual/src/application/commands/config.ts': [
            "import { assertRepository as gentle } from '../primitives/internal/repo-state.js';",
            'export const configGet = async (ctx: unknown): Promise<void> => {',
            '  await gentle(ctx);',
            '};',
            '',
          ].join('\n'),
        });

        // Act
        const result = computeFindings(callSites, []);

        // Assert
        expect(result.unguarded).toEqual([
          { module: 'src/application/commands/config.ts', verb: 'configGet', line: 3 },
        ]);
      });
    });
  });

  describe('Given a call reached through a re-export shim', () => {
    describe('When analyzed', () => {
      it('Then the call is attributed to the calling verb, not the shim', () => {
        // Arrange
        const callSites = analyze({
          [TARGET_MODULE]: PRIMITIVES_SOURCE,
          '/virtual/src/application/commands/internal/repo-state.ts':
            "export { assertRepository } from '../../primitives/internal/repo-state.js';\n",
          '/virtual/src/application/commands/config.ts': [
            "import { assertRepository } from './internal/repo-state.js';",
            'export const configGet = async (ctx: unknown): Promise<void> => {',
            '  await assertRepository(ctx);',
            '};',
            '',
          ].join('\n'),
        });

        // Act
        const result = computeFindings(callSites, []);

        // Assert
        expect(result.unguarded).toEqual([
          { module: 'src/application/commands/config.ts', verb: 'configGet', line: 3 },
        ]);
      });
    });
  });

  describe('Given a call at module top level (outside any exported declaration)', () => {
    describe('When analyzed', () => {
      it('Then the call is reported as unattributable rather than skipped', () => {
        // Arrange
        const callSites = analyze({
          [TARGET_MODULE]: PRIMITIVES_SOURCE,
          '/virtual/src/application/commands/stash.ts': [
            "import { assertRepository } from '../primitives/internal/repo-state.js';",
            'await assertRepository({});',
            '',
          ].join('\n'),
        });

        // Act
        const result = computeFindings(callSites, []);

        // Assert
        expect(result.unattributable).toEqual([
          { module: 'src/application/commands/stash.ts', line: 2 },
        ]);
      });
    });
  });

  describe('Given a call inside a non-exported helper function', () => {
    describe('When analyzed', () => {
      it('Then the call is reported as unattributable rather than skipped', () => {
        // Arrange
        const callSites = analyze({
          [TARGET_MODULE]: PRIMITIVES_SOURCE,
          '/virtual/src/application/commands/stash.ts': [
            "import { assertRepository } from '../primitives/internal/repo-state.js';",
            'const helper = async (ctx: unknown): Promise<void> => {',
            '  await assertRepository(ctx);',
            '};',
            'void helper;',
            '',
          ].join('\n'),
        });

        // Act
        const result = computeFindings(callSites, []);

        // Assert
        expect(result.unattributable).toEqual([
          { module: 'src/application/commands/stash.ts', line: 3 },
        ]);
      });
    });
  });
});

describe('the shipped allowlist', () => {
  describe('Given tooling/audit-assert-tier.allowlist.json', () => {
    describe('When parsed', () => {
      it('Then it has exactly the five documented entries', async () => {
        // Arrange
        const raw = await readFile(SHIPPED_ALLOWLIST, 'utf8');

        // Act
        const result = parseAllowlist(raw);

        // Assert
        expect(result).toEqual([
          {
            module: 'src/application/commands/config.ts',
            verb: 'configGet',
            reason:
              "git's `config --get` exits 1 (not-found), not 128, on a rejected repository; pinned by the tier co-truth sweep.",
          },
          {
            module: 'src/application/commands/config.ts',
            verb: 'configGetAll',
            reason: 'same porcelain row as configGet; pinned by the tier co-truth sweep.',
          },
          {
            module: 'src/application/commands/config.ts',
            verb: 'configGetRegexp',
            reason:
              "git's `config --get-regexp` exits 1 on a rejected repository; pinned by the tier co-truth sweep.",
          },
          {
            module: 'src/application/commands/config.ts',
            verb: 'configList',
            reason:
              "git's `config --list` exits 0 with the repository scope dropped; pinned by the tier co-truth sweep.",
          },
          {
            module: 'src/application/primitives/internal/repo-state.ts',
            verb: 'assertAcceptedRepository',
            reason:
              'the tier chain itself — assertAcceptedRepository is defined as assertRepository plus the acceptance gates.',
          },
        ]);
      });
    });
  });
});

describe('runAudit', () => {
  describe('Given the real src/ tree and the shipped allowlist', () => {
    describe('When the audit runs', () => {
      it('Then every call site is either allowlisted or an allowlisted verb, with no stale entries', async () => {
        // Arrange
        const sut = runAudit;

        // Act
        const result = await sut({ root: REPO_ROOT_REAL, allowlist: SHIPPED_ALLOWLIST });

        // Assert
        expect(result.unguarded).toEqual([]);
        expect(result.unattributable).toEqual([]);
        expect(result.stale).toEqual([]);
      });
    });
  });
});
