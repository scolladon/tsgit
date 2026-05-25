import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  type AllowEntry,
  type Allowlist,
  buildReport,
  formatGapMessage,
  parseAllowlist,
  parseArgs,
  parseRepositoryInterface,
  type ScanFile,
  scanCallSites,
  validateAllowlistNames,
} from '../../audit-browser-surface.ts';

describe('parseRepositoryInterface', () => {
  describe('Given a Repository interface with commands and primitives', () => {
    describe('When parsed', () => {
      it('Then both tier name sets are returned and dispose/ctx/primitives are filtered', () => {
        // Arrange
        const sut = [
          'interface Repository {',
          '  readonly add: BindCtx<typeof commands.add>;',
          '  readonly branch: BindCtx<typeof commands.branch>;',
          '  readonly primitives: {',
          '    readonly readObject: BindCtx<typeof primitives.readObject>;',
          '    readonly walkCommits: BindCtx<typeof primitives.walkCommits>;',
          '  };',
          '  readonly ctx: Context;',
          '  readonly dispose: () => Promise<void>;',
          '}',
        ].join('\n');

        // Act
        const actual = parseRepositoryInterface(sut);

        // Assert
        expect(actual).toEqual({
          commands: ['add', 'branch'],
          primitives: ['readObject', 'walkCommits'],
        });
      });
    });
  });

  describe('Given a source without a primitives block', () => {
    describe('When parsed', () => {
      it('Then primitives is empty', () => {
        // Arrange
        const sut = [
          'interface Repository {',
          '  readonly add: BindCtx<typeof commands.add>;',
          '}',
        ].join('\n');

        // Act
        const actual = parseRepositoryInterface(sut);

        // Assert
        expect(actual).toEqual({ commands: ['add'], primitives: [] });
      });
    });
  });
});

describe('scanCallSites', () => {
  describe('Given a source with command, primitive, and skip-set call sites', () => {
    describe('When scanned', () => {
      it('Then commands and primitives sets are returned and skip-set names are filtered', () => {
        // Arrange
        const sut = [
          'const a = await repo.add(["x.txt"]);',
          'const b = await repo.commit({ message: "m", author });',
          'const c = await repo.primitives.readObject(id);',
          'const d = await repo.primitives.walkCommits(start);',
          'await repo.dispose();',
          'await repo.primitives.walkTree(treeId);',
        ].join('\n');

        // Act
        const actual = scanCallSites(sut);

        // Assert
        expect([...actual.commands].sort()).toEqual(['add', 'commit']);
        expect([...actual.primitives].sort()).toEqual(['readObject', 'walkCommits', 'walkTree']);
      });
    });
  });

  describe('Given a source with a mismatched receiver name', () => {
    describe('When scanned', () => {
      it('Then mockRepo.add does not count as repo.add coverage', () => {
        // Arrange
        const sut = ['await mockRepo.add(["x.txt"]);', 'await myRepo.commit(opts);'].join('\n');

        // Act
        const actual = scanCallSites(sut);

        // Assert
        expect(actual.commands.size).toBe(0);
        expect(actual.primitives.size).toBe(0);
      });
    });
  });

  describe('Given a source with repo.primitives without a method', () => {
    describe('When scanned', () => {
      it('Then the bare repo.primitives reference is filtered (not counted as repo.primitives call)', () => {
        // Arrange
        const sut = 'const p = repo.primitives;\nawait p.readObject(id);';

        // Act
        const actual = scanCallSites(sut);

        // Assert
        // `p.readObject(...)` does not match `repo.primitives.readObject(`,
        // and `repo.primitives;` has no trailing `(` so it is also ignored.
        expect(actual.commands.size).toBe(0);
        expect(actual.primitives.size).toBe(0);
      });
    });
  });

  describe('Given a source that calls repo.primitives() as if it were a function', () => {
    describe('When scanned', () => {
      it('Then the literal name `primitives` is filtered out of commands (TIER1_SKIP)', () => {
        // Arrange
        const sut = ['await repo.primitives();', 'await repo.ctx();'].join('\n');

        // Act
        const actual = scanCallSites(sut);

        // Assert
        // Both names are in TIER1_SKIP; neither should land in the
        // commands set. A mutant that drops the skip filter would
        // surface `primitives` and `ctx` here and fail.
        expect(actual.commands.size).toBe(0);
        expect(actual.primitives.size).toBe(0);
      });
    });
  });
});

describe('parseAllowlist', () => {
  describe('Given a well-formed allowlist JSON', () => {
    describe('When parsed', () => {
      it('Then the structured allowlist is returned', () => {
        // Arrange
        const sut = JSON.stringify({
          commands: [{ name: 'clone', reason: 'needs server', deferredTo: '19.8' }],
          primitives: [{ name: 'runHook', reason: 'no runner', deferredTo: null }],
        });

        // Act
        const actual = parseAllowlist(sut);

        // Assert
        expect(actual).toEqual({
          commands: [{ name: 'clone', reason: 'needs server', deferredTo: '19.8' }],
          primitives: [{ name: 'runHook', reason: 'no runner', deferredTo: null }],
        });
      });
    });
  });

  describe('Given malformed JSON', () => {
    describe('When parsed', () => {
      it('Then a descriptive error is thrown', () => {
        // Arrange
        const sut = '{ broken';

        // Act + Assert
        try {
          parseAllowlist(sut);
          expect.unreachable();
        } catch (err) {
          expect((err as Error).message).toMatch(/^allowlist: invalid JSON/);
        }
      });
    });
  });

  describe('Given a top-level array', () => {
    describe('When parsed', () => {
      it('Then it is rejected as a non-object', () => {
        // Arrange
        const sut = '[]';

        // Act + Assert
        try {
          parseAllowlist(sut);
          expect.unreachable();
        } catch (err) {
          expect((err as Error).message).toBe(
            'allowlist: expected an object with {commands, primitives}',
          );
        }
      });
    });
  });

  describe('Given an entry with a missing reason', () => {
    describe('When parsed', () => {
      it('Then the failing entry index is named in the error', () => {
        // Arrange
        const sut = JSON.stringify({
          commands: [{ name: 'clone', reason: '', deferredTo: null }],
          primitives: [],
        });

        // Act + Assert
        try {
          parseAllowlist(sut);
          expect.unreachable();
        } catch (err) {
          expect((err as Error).message).toBe(
            'allowlist.commands[0]: malformed entry (need {name, reason, deferredTo})',
          );
        }
      });
    });
  });

  describe('Given an entry with a non-string non-null deferredTo', () => {
    describe('When parsed', () => {
      it('Then the entry is rejected', () => {
        // Arrange
        const sut = JSON.stringify({
          commands: [{ name: 'clone', reason: 'r', deferredTo: 19 }],
          primitives: [],
        });

        // Act + Assert
        try {
          parseAllowlist(sut);
          expect.unreachable();
        } catch (err) {
          expect((err as Error).message).toBe(
            'allowlist.commands[0]: malformed entry (need {name, reason, deferredTo})',
          );
        }
      });
    });
  });

  describe('Given a non-array primitives tier', () => {
    describe('When parsed', () => {
      it('Then the tier rejection error names the tier', () => {
        // Arrange
        const sut = JSON.stringify({ commands: [], primitives: 'oops' });

        // Act + Assert
        try {
          parseAllowlist(sut);
          expect.unreachable();
        } catch (err) {
          expect((err as Error).message).toBe('allowlist.primitives: expected an array');
        }
      });
    });
  });

  describe('Given an object with the commands key absent entirely', () => {
    describe('When parsed', () => {
      it('Then the commands tier rejection fires (undefined is not an array)', () => {
        // Arrange
        const sut = JSON.stringify({ primitives: [] });

        // Act + Assert
        try {
          parseAllowlist(sut);
          expect.unreachable();
        } catch (err) {
          expect((err as Error).message).toBe('allowlist.commands: expected an array');
        }
      });
    });
  });
});

describe('validateAllowlistNames', () => {
  describe('Given an allowlist entry naming a removed surface', () => {
    describe('When validated against the bound facade', () => {
      it('Then the audit refuses to start until the stale entry is removed', () => {
        // Arrange
        const sut: Allowlist = {
          commands: [{ name: 'cloneRemoved', reason: 'r', deferredTo: null }],
          primitives: [],
        };
        const bound = { commands: ['clone', 'add'], primitives: [] };

        // Act + Assert
        try {
          validateAllowlistNames(sut, bound);
          expect.unreachable();
        } catch (err) {
          expect((err as Error).message).toMatch(
            /^allowlist\.commands: 'cloneRemoved' is not currently bound/,
          );
        }
      });
    });
  });

  describe('Given an allowlist whose primitive entry is removed from the facade', () => {
    describe('When validated', () => {
      it('Then the primitive tier rejection names the entry', () => {
        // Arrange
        const sut: Allowlist = {
          commands: [],
          primitives: [{ name: 'gone', reason: 'r', deferredTo: null }],
        };
        const bound = { commands: [], primitives: ['readObject'] };

        // Act + Assert
        try {
          validateAllowlistNames(sut, bound);
          expect.unreachable();
        } catch (err) {
          expect((err as Error).message).toMatch(
            /^allowlist\.primitives: 'gone' is not currently bound/,
          );
        }
      });
    });
  });

  describe('Given an allowlist with all entries naming bound surfaces', () => {
    describe('When validated', () => {
      it('Then validation passes silently', () => {
        // Arrange
        const sut: Allowlist = {
          commands: [{ name: 'clone', reason: 'r', deferredTo: null }],
          primitives: [{ name: 'runHook', reason: 'r', deferredTo: null }],
        };
        const bound = { commands: ['clone'], primitives: ['runHook'] };

        // Act
        const result = (): void => validateAllowlistNames(sut, bound);

        // Assert
        expect(result).not.toThrow();
      });
    });
  });
});

describe('buildReport', () => {
  describe('Given bound surfaces, files with coverage, and an allowlist', () => {
    describe('When the report is built', () => {
      it('Then summary tallies match the per-tier covered/exempt/gap lists', () => {
        // Arrange
        const bound = {
          commands: ['add', 'branch', 'clone', 'commit'],
          primitives: ['readObject', 'walkCommits', 'runHook'],
        };
        const files: ReadonlyArray<ScanFile> = [
          {
            path: 'test/browser/foo.spec.ts',
            source: 'await repo.add([]); await repo.commit({});',
          },
          {
            path: 'test/parity/scenarios/bar.scenario.ts',
            source: 'await repo.branch({}); await repo.primitives.readObject(id);',
          },
        ];
        const allowlist: Allowlist = {
          commands: [{ name: 'clone', reason: 'r', deferredTo: '19.8' }],
          primitives: [{ name: 'runHook', reason: 'r', deferredTo: null }],
        };

        // Act
        const sut = buildReport(bound, files, allowlist);

        // Assert
        expect(sut.summary).toEqual({
          commands: { bound: 4, covered: 3, exempt: 1, gaps: 0 },
          primitives: { bound: 3, covered: 1, exempt: 1, gaps: 1 },
        });
        expect(sut.gaps.commands).toEqual([]);
        expect(sut.gaps.primitives).toEqual(['walkCommits']);
        // Lock the covered.primitives shape — a mutant that bypassed the
        // primitive coverage map would leave this list empty even though
        // `summary.primitives.covered` accidentally still tallied a 1.
        expect(sut.covered.primitives).toEqual([
          { name: 'readObject', sources: ['test/parity/scenarios/bar.scenario.ts'] },
        ]);
      });
    });
  });

  describe('Given a covered name with multiple source files', () => {
    describe('When the report is built', () => {
      it('Then the covered entry lists every source file alphabetically once', () => {
        // Arrange
        const bound = { commands: ['add'], primitives: [] };
        const files: ReadonlyArray<ScanFile> = [
          { path: 'test/parity/scenarios/zeta.scenario.ts', source: 'await repo.add([]);' },
          { path: 'test/browser/alpha.spec.ts', source: 'await repo.add(["a"]);' },
          { path: 'test/browser/alpha.spec.ts', source: 'await repo.add(["b"]);' },
        ];
        const allowlist: Allowlist = { commands: [], primitives: [] };

        // Act
        const sut = buildReport(bound, files, allowlist);

        // Assert
        expect(sut.covered.commands).toEqual([
          {
            name: 'add',
            sources: ['test/browser/alpha.spec.ts', 'test/parity/scenarios/zeta.scenario.ts'],
          },
        ]);
      });
    });
  });

  describe('Given gap names', () => {
    describe('When the report is built', () => {
      it('Then gaps are sorted alphabetically per tier', () => {
        // Arrange
        const bound = {
          commands: ['zeta', 'alpha', 'beta'],
          primitives: ['xi', 'omega', 'alpha'],
        };
        const allowlist: Allowlist = { commands: [], primitives: [] };

        // Act
        const sut = buildReport(bound, [], allowlist);

        // Assert
        expect(sut.gaps.commands).toEqual(['alpha', 'beta', 'zeta']);
        expect(sut.gaps.primitives).toEqual(['alpha', 'omega', 'xi']);
      });
    });
  });
});

describe('formatGapMessage', () => {
  describe('Given a report with gaps in both tiers', () => {
    describe('When formatted', () => {
      it('Then the message names every gap under its tier heading', () => {
        // Arrange
        const sut = buildReport(
          { commands: ['clone'], primitives: ['runHook'] },
          [],
          { commands: [], primitives: [] },
        );

        // Act
        const message = formatGapMessage(sut);

        // Assert
        expect(message).toContain('Commands without browser coverage:');
        expect(message).toContain('  - repo.clone');
        expect(message).toContain('Primitives without browser coverage:');
        expect(message).toContain('  - repo.primitives.runHook');
        expect(message).toContain('Close each gap');
      });
    });
  });

  describe('Given a report with only command gaps', () => {
    describe('When formatted', () => {
      it('Then the primitives heading is omitted', () => {
        // Arrange
        const sut = buildReport(
          { commands: ['clone'], primitives: [] },
          [],
          { commands: [], primitives: [] },
        );

        // Act
        const message = formatGapMessage(sut);

        // Assert
        expect(message).toContain('Commands without browser coverage:');
        expect(message).not.toContain('Primitives without browser coverage:');
      });
    });
  });

  describe('Given a report with only primitive gaps', () => {
    describe('When formatted', () => {
      it('Then the commands heading is omitted but the primitives one is present', () => {
        // Arrange
        const sut = buildReport(
          { commands: [], primitives: ['runHook'] },
          [],
          { commands: [], primitives: [] },
        );

        // Act
        const message = formatGapMessage(sut);

        // Assert
        expect(message).not.toContain('Commands without browser coverage:');
        expect(message).toContain('Primitives without browser coverage:');
        expect(message).toContain('  - repo.primitives.runHook');
      });
    });
  });
});

describe('parseArgs', () => {
  describe('Given no arguments', () => {
    describe('When parsed', () => {
      it('Then defaults are repoRoot + repoRoot/reports + the allowlist under tooling/', () => {
        // Arrange + Act
        const sut = parseArgs([]);

        // Assert
        // The derived root is set from the script's location; lock the
        // structural relationship between root, out, and allowlist so a
        // refactor that detaches `out` from `root` (e.g. hardcoding
        // `/reports`) fails loudly. `path.join` keeps the assertion
        // portable across POSIX (forward slash) and Windows (backslash).
        expect(sut.out).toBe(path.join(sut.root, 'reports'));
        expect(sut.allowlist).toBe(
          path.join(sut.root, 'tooling', 'audit-browser-surface.allowlist.json'),
        );
      });
    });
  });

  describe('Given --root, --out, and --allowlist flags', () => {
    describe('When parsed', () => {
      it('Then the absolute paths are returned', () => {
        // Arrange
        const argv: ReadonlyArray<string> = [
          '--root',
          '/tmp/repo',
          '--out',
          '/tmp/out',
          '--allowlist',
          '/tmp/allow.json',
        ];

        // Act
        const sut = parseArgs(argv);

        // Assert — `path.resolve` is platform-specific: on POSIX
        // `/tmp/repo` stays as-is, on Windows it normalises to a drive-
        // prefixed backslash path. Mirror the resolver in the expectation
        // so the assertion is portable.
        expect(sut).toEqual({
          root: path.resolve('/tmp/repo'),
          out: path.resolve('/tmp/out'),
          allowlist: path.resolve('/tmp/allow.json'),
        });
      });
    });
  });

  describe('Given --root only', () => {
    describe('When parsed', () => {
      it('Then out and allowlist defaults derive from the supplied root', () => {
        // Arrange
        const expectedRoot = path.resolve('/tmp/repo');

        // Act
        const sut = parseArgs(['--root', '/tmp/repo']);

        // Assert
        expect(sut.root).toBe(expectedRoot);
        expect(sut.out).toBe(path.join(expectedRoot, 'reports'));
        expect(sut.allowlist).toBe(
          path.join(expectedRoot, 'tooling', 'audit-browser-surface.allowlist.json'),
        );
      });
    });
  });

  describe('Given a flag without a value', () => {
    describe('When parsed', () => {
      it('Then a descriptive error is thrown', () => {
        // Arrange + Act + Assert
        try {
          parseArgs(['--root']);
          expect.unreachable();
        } catch (err) {
          expect((err as Error).message).toBe('--root requires a value');
        }
      });
    });
  });

  describe('Given an unknown flag', () => {
    describe('When parsed', () => {
      it('Then the unknown flag is named', () => {
        // Arrange + Act + Assert
        try {
          parseArgs(['--bogus', 'x']);
          expect.unreachable();
        } catch (err) {
          expect((err as Error).message).toBe('unknown flag: --bogus');
        }
      });
    });
  });

  describe('Given --out without a value', () => {
    describe('When parsed', () => {
      it('Then --out requires a value', () => {
        // Arrange + Act + Assert
        try {
          parseArgs(['--out']);
          expect.unreachable();
        } catch (err) {
          expect((err as Error).message).toBe('--out requires a value');
        }
      });
    });
  });

  describe('Given --allowlist without a value', () => {
    describe('When parsed', () => {
      it('Then --allowlist requires a value', () => {
        // Arrange + Act + Assert
        try {
          parseArgs(['--allowlist']);
          expect.unreachable();
        } catch (err) {
          expect((err as Error).message).toBe('--allowlist requires a value');
        }
      });
    });
  });
});

// Locks in that the exported AllowEntry type remains shaped {name, reason,
// deferredTo} — a guard against accidental schema changes that would slip
// past JSON validation alone.
describe('Given an AllowEntry literal', () => {
  describe('When typed', () => {
    it('Then it accepts the documented three-field shape', () => {
      // Arrange
      const sut: AllowEntry = { name: 'x', reason: 'why', deferredTo: null };

      // Assert
      expect(sut.name).toBe('x');
      expect(sut.deferredTo).toBeNull();
    });
  });
});
