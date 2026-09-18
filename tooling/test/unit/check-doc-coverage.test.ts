import * as path from 'node:path';
import * as url from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  checkDocsExist,
  checkIndexRow,
  findDetachedDocComments,
  formatDetachedStanza,
  formatGapStanza,
  kebabCase,
  parseAllowList,
  parseRepositoryInterface,
  runCheck,
  scanDetachedDocComments,
} from '../../check-doc-coverage.js';

const REPO_ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../..');

describe('parseRepositoryInterface', () => {
  describe("Given a Repository interface with three commands and two primitives", () => {
    describe("When parsed", () => {
      it('Then both name sets are returned', () => {
    // Arrange
    const source = [
      'interface Repository {',
      '  readonly add: BindCtx<typeof commands.add>;',
      '  readonly branch: BindCtx<typeof commands.branch>;',
      '  readonly clone: BindCtx<typeof commands.clone>;',
      '  readonly primitives: {',
      '    readonly readObject: BindCtx<typeof primitives.readObject>;',
      '    readonly walkCommits: BindCtx<typeof primitives.walkCommits>;',
      '  };',
      '  readonly ctx: Context;',
      '  readonly dispose: () => Promise<void>;',
      '}',
    ].join('\n');

    // Act
    const result = parseRepositoryInterface(source);

    // Assert
    expect(result).toEqual({
      commands: ['add', 'branch', 'clone'],
      primitives: ['readObject', 'walkCommits'],
    });
  });
    });
  });

  describe("Given a source with no primitives block", () => {
    describe("When parsed", () => {
      it('Then primitives is empty', () => {
    // Arrange
    const source = [
      'interface Repository {',
      '  readonly add: BindCtx<typeof commands.add>;',
      '}',
    ].join('\n');

    // Act
    const result = parseRepositoryInterface(source);

    // Assert
    expect(result.primitives).toEqual([]);
    expect(result.commands).toEqual(['add']);
  });
    });
  });

  describe("Given a source where BindCtx is renamed", () => {
    describe("When parsed", () => {
      it('Then both sets are empty', () => {
    // Arrange
    const source = [
      'interface Repository {',
      '  readonly add: Renamed<typeof commands.add>;',
      '  readonly primitives: {',
      '    readonly readObject: Renamed<typeof primitives.readObject>;',
      '  };',
      '}',
    ].join('\n');

    // Act
    const result = parseRepositoryInterface(source);

    // Assert
    expect(result.commands).toEqual([]);
    expect(result.primitives).toEqual([]);
  });
    });
  });

  describe("Given the slot names primitives / ctx / dispose at the top level", () => {
    describe("When parsed", () => {
      it('Then they are excluded from commands', () => {
    // Arrange
    const source = [
      'interface Repository {',
      '  readonly add: BindCtx<typeof commands.add>;',
      '  readonly primitives: {',
      '    readonly readObject: BindCtx<typeof primitives.readObject>;',
      '  };',
      '  readonly ctx: Context;',
      '  readonly dispose: () => Promise<void>;',
      '}',
    ].join('\n');

    // Act
    const result = parseRepositoryInterface(source);

    // Assert
    expect(result.commands).toEqual(['add']);
  });
    });
  });

  describe('Given nested-namespace command bindings', () => {
    describe('When parsed', () => {
      it('Then commands.*Namespace bindings join the flat commands', () => {
        // Arrange — `config`/`remote` are namespace objects, not BindCtx<…>;
        // `snapshot` is a non-commands namespace type and must NOT be captured.
        const source = [
          'interface Repository {',
          '  readonly add: BindCtx<typeof commands.add>;',
          '  readonly config: commands.ConfigNamespace;',
          '  readonly remote: commands.RemoteNamespace;',
          '  readonly snapshot: SnapshotFactory;',
          '}',
        ].join('\n');

        // Act
        const result = parseRepositoryInterface(source);

        // Assert
        expect(result.commands).toEqual(['add', 'config', 'remote']);
      });
    });
  });
});

describe('kebabCase', () => {
  describe("Given a single-word camel case", () => {
    describe("When kebab-cased", () => {
      it('Then the same lower-case word is returned', () => {
    // Arrange + Act
    const result = kebabCase('clone');

    // Assert
    expect(result).toBe('clone');
  });
    });
  });

  describe("Given catFile", () => {
    describe("When kebab-cased", () => {
      it('Then cat-file', () => {
    // Arrange + Act
    const result = kebabCase('catFile');

    // Assert
    expect(result).toBe('cat-file');
  });
    });
  });

  describe("Given revParse", () => {
    describe("When kebab-cased", () => {
      it('Then rev-parse', () => {
    // Arrange + Act
    const result = kebabCase('revParse');

    // Assert
    expect(result).toBe('rev-parse');
  });
    });
  });

  describe("Given fetchMissing", () => {
    describe("When kebab-cased", () => {
      it('Then fetch-missing', () => {
    // Arrange + Act
    const result = kebabCase('fetchMissing');

    // Assert
    expect(result).toBe('fetch-missing');
  });
    });
  });

  describe("Given sparseCheckout", () => {
    describe("When kebab-cased", () => {
      it('Then sparse-checkout', () => {
    // Arrange + Act
    const result = kebabCase('sparseCheckout');

    // Assert
    expect(result).toBe('sparse-checkout');
  });
    });
  });
});

describe('checkDocsExist', () => {
  describe("Given a docs root with the expected file", () => {
    describe("When checkDocsExist runs", () => {
      it('Then no gaps are returned', () => {
    // Arrange
    const expected = path.join('/docs', 'commands', 'clone.md');
    const fileExists = (p: string): boolean => p === expected;

    // Act
    const result = checkDocsExist('commands', ['clone'], '/docs', [], fileExists);

    // Assert
    expect(result).toEqual([]);
  });
    });
  });

  describe("Given a docs root missing the expected file", () => {
    describe("When checkDocsExist runs", () => {
      it('Then one gap is returned with the missing path', () => {
    // Arrange
    const fileExists = (): boolean => false;

    // Act
    const result = checkDocsExist('commands', ['clone'], '/docs', [], fileExists);

    // Assert
    expect(result).toEqual([
      {
        kind: 'commands',
        name: 'clone',
        missing: 'file',
        expectedPath: path.join('/docs', 'commands', 'clone.md'),
      },
    ]);
  });
    });
  });

  describe("Given a name in the allowlist", () => {
    describe("When checkDocsExist runs against a missing file", () => {
      it('Then no gap is returned', () => {
    // Arrange
    const fileExists = (): boolean => false;

    // Act
    const result = checkDocsExist('commands', ['clone'], '/docs', ['clone'], fileExists);

    // Assert
    expect(result).toEqual([]);
  });
    });
  });

  describe("Given multiple names", () => {
    describe("When some are missing and others exist", () => {
      it('Then only the missing ones are reported', () => {
    // Arrange
    const expected = path.join('/docs', 'commands', 'clone.md');
    const fileExists = (p: string): boolean => p === expected;

    // Act
    const result = checkDocsExist('commands', ['clone', 'add', 'commit'], '/docs', [], fileExists);

    // Assert
    expect(result.map((g) => g.name)).toEqual(['add', 'commit']);
  });
    });
  });
});

describe('checkIndexRow', () => {
  describe("Given a README containing the expected row", () => {
    describe("When checkIndexRow runs", () => {
      it('Then no gap is returned', () => {
    // Arrange
    const readFile = (): string => '| [`clone`](clone.md) | Clone a remote |';

    // Act
    const result = checkIndexRow('commands', ['clone'], '/docs', [], readFile);

    // Assert
    expect(result).toEqual([]);
  });
    });
  });

  describe("Given a README missing the expected row", () => {
    describe("When checkIndexRow runs", () => {
      it('Then one gap is returned', () => {
    // Arrange
    const readFile = (): string => 'no entries here';

    // Act
    const result = checkIndexRow('commands', ['clone'], '/docs', [], readFile);

    // Assert
    expect(result).toEqual([
      {
        kind: 'commands',
        name: 'clone',
        missing: 'index-row',
        expectedPath: path.join('/docs', 'commands', 'README.md'),
      },
    ]);
  });
    });
  });

  describe("Given a README that cannot be read", () => {
    describe("When checkIndexRow runs", () => {
      it('Then every name surfaces as an index-row gap', () => {
    // Arrange
    const readFile = (): string => {
      throw new Error('ENOENT');
    };

    // Act
    const result = checkIndexRow('commands', ['clone', 'add'], '/docs', [], readFile);

    // Assert
    expect(result.map((g) => g.name)).toEqual(['clone', 'add']);
    expect(result.every((g) => g.missing === 'index-row')).toBe(true);
  });
    });
  });

  describe("Given a name in the allowlist", () => {
    describe("When checkIndexRow runs against a README missing that row", () => {
      it('Then no gap is returned', () => {
    // Arrange
    const readFile = (): string => '';

    // Act
    const result = checkIndexRow('commands', ['clone'], '/docs', ['clone'], readFile);

    // Assert
    expect(result).toEqual([]);
  });
    });
  });
});

describe('formatGapStanza', () => {
  describe("Given a missing-file gap", () => {
    describe("When formatted", () => {
      it('Then the stanza names the expected file and index entry', () => {
    // Arrange
    const gap = {
      kind: 'commands' as const,
      name: 'clone',
      missing: 'file' as const,
      expectedPath: '/repo/docs/use/commands/clone.md',
    };

    // Act
    const result = formatGapStanza(gap);

    // Assert
    expect(result).toContain('ERROR /repo/docs/use/commands/clone.md missing');
    expect(result).toContain('Surface symbol: repo.clone');
    expect(result).toContain('[`clone`](clone.md)');
  });
    });
  });

  describe("Given a primitives gap", () => {
    describe("When formatted", () => {
      it('Then the surface symbol includes the primitives. prefix', () => {
    // Arrange
    const gap = {
      kind: 'primitives' as const,
      name: 'readObject',
      missing: 'file' as const,
      expectedPath: '/repo/docs/use/primitives/read-object.md',
    };

    // Act
    const result = formatGapStanza(gap);

    // Assert
    expect(result).toContain('Surface symbol: repo.primitives.readObject');
  });
    });
  });

  describe("Given a missing-index-row gap", () => {
    describe("When formatted", () => {
      it('Then the stanza names the README and the link target', () => {
    // Arrange
    const gap = {
      kind: 'commands' as const,
      name: 'clone',
      missing: 'index-row' as const,
      expectedPath: '/repo/docs/use/commands/README.md',
    };

    // Act
    const result = formatGapStanza(gap);

    // Assert
    expect(result).toContain('missing index row for `clone`');
    expect(result).toContain('/repo/docs/use/commands/clone.md');
  });
    });
  });
});

describe('runCheck against the real repo', () => {
  describe("Given the live repository.ts + docs tree", () => {
    describe("When runCheck runs", () => {
      it('Then no gaps are reported', () => {
    // Arrange + Act
    const result = runCheck(REPO_ROOT);

    // Assert
    expect(result).toEqual([]);
  });
    });
  });

  describe("Given a synthesised repository.ts with zero commands and zero primitives", () => {
    describe("When runCheck runs", () => {
      it('Then it throws', () => {
    // Arrange
    const readSource = (): string => 'interface Repository {}';

    // Act + Assert
    expect(() => runCheck('/any/root', readSource)).toThrow(/zero commands AND zero primitives/);
  });
    });
  });
});

describe('parseAllowList', () => {
  describe("Given a valid JSON object with both arrays", () => {
    describe("When parsed", () => {
      it('Then both lists are returned', () => {
    // Arrange
    const raw = JSON.stringify({ commands: ['clone'], primitives: ['readObject'] });

    // Act
    const result = parseAllowList(raw);

    // Assert
    expect(result).toEqual({ commands: ['clone'], primitives: ['readObject'] });
  });
    });
  });

  describe("Given JSON whose commands is a non-array", () => {
    describe("When parsed", () => {
      it('Then commands defaults to empty', () => {
    // Arrange
    const raw = JSON.stringify({ commands: 'oops', primitives: [] });

    // Act
    const result = parseAllowList(raw);

    // Assert
    expect(result.commands).toEqual([]);
  });
    });
  });

  describe("Given JSON whose entries contain non-strings", () => {
    describe("When parsed", () => {
      it('Then non-strings are filtered out', () => {
    // Arrange
    const raw = JSON.stringify({ commands: ['clone', 42, null, 'add'], primitives: [] });

    // Act
    const result = parseAllowList(raw);

    // Assert
    expect(result.commands).toEqual(['clone', 'add']);
  });
    });
  });

  describe("Given malformed JSON", () => {
    describe("When parsed", () => {
      it('Then both lists default to empty', () => {
    // Arrange
    const raw = '{ not valid json';

    // Act
    const result = parseAllowList(raw);

    // Assert
    expect(result).toEqual({ commands: [], primitives: [] });
  });
    });
  });

  describe("Given JSON parsing to a non-object value (e.g. an array)", () => {
    describe("When parsed", () => {
      it('Then both lists default to empty', () => {
    // Arrange
    const raw = JSON.stringify(['just', 'an', 'array']);

    // Act
    const result = parseAllowList(raw);

    // Assert
    expect(result).toEqual({ commands: [], primitives: [] });
  });
    });
  });

  describe("Given JSON parsing to null", () => {
    describe("When parsed", () => {
      it('Then both lists default to empty', () => {
    // Arrange
    const raw = 'null';

    // Act
    const result = parseAllowList(raw);

    // Assert
    expect(result).toEqual({ commands: [], primitives: [] });
  });
    });
  });
});

describe('findDetachedDocComments', () => {
  describe('Given a doc comment immediately followed by another doc comment', () => {
    describe('When the source is scanned', () => {
      it('Then the line the detached comment closes on is reported', () => {
        // Arrange
        const sut = findDetachedDocComments;
        const source = [
          '/**',
          ' * Documents the declaration below.',
          ' */',
          '/** Documents it too, and wins. */',
          'export const value = 1;',
        ].join('\n');

        // Act
        const result = sut('src/example.ts', source);

        // Assert
        expect(result).toEqual([{ file: 'src/example.ts', line: 3 }]);
      });
    });
  });

  describe('Given two doc comments separated by a blank line', () => {
    describe('When the source is scanned', () => {
      it('Then nothing is reported, because a file header is not detached', () => {
        // Arrange
        const sut = findDetachedDocComments;
        const source = [
          '/**',
          ' * Describes the whole module.',
          ' */',
          '',
          '/** Describes the declaration. */',
          'export const value = 1;',
        ].join('\n');

        // Act
        const result = sut('src/example.ts', source);

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given a file with two separate detached comments', () => {
    describe('When the source is scanned', () => {
      it('Then both are reported in source order', () => {
        // Arrange
        const sut = findDetachedDocComments;
        const source = [
          '/** first */',
          '/** second */',
          'export const a = 1;',
          '/** third */',
          '/** fourth */',
          'export const b = 2;',
        ].join('\n');

        // Act
        const result = sut('src/example.ts', source);

        // Assert
        expect(result).toEqual([
          { file: 'src/example.ts', line: 1 },
          { file: 'src/example.ts', line: 4 },
        ]);
      });
    });
  });
});

describe('scanDetachedDocComments', () => {
  describe('Given a source tree whose every doc comment is attached', () => {
    describe('When the tree is scanned', () => {
      it('Then no detached comment is reported', () => {
        // Arrange
        const sut = scanDetachedDocComments;
        const listFiles = (root: string): ReadonlyArray<string> => [path.join(root, 'clean.ts')];
        const readSource = (): string => '/** Attached. */\nexport const value = 1;\n';

        // Act
        const result = sut(REPO_ROOT, listFiles, readSource);

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given a source tree carrying one detached doc comment', () => {
    describe('When the tree is scanned', () => {
      it('Then it is reported under its path relative to the repository root', () => {
        // Arrange
        const sut = scanDetachedDocComments;
        const listFiles = (root: string): ReadonlyArray<string> => [path.join(root, 'orphan.ts')];
        const readSource = (): string => '/** Lost. */\n/** Kept. */\nexport const value = 1;\n';

        // Act
        const result = sut(REPO_ROOT, listFiles, readSource);

        // Assert
        expect(result).toEqual([{ file: path.join('src', 'orphan.ts'), line: 1 }]);
      });
    });
  });

  describe('Given the repository as it stands', () => {
    describe('When its own source tree is scanned', () => {
      it('Then no published doc comment is detached', () => {
        // Arrange
        const sut = scanDetachedDocComments;

        // Act
        const result = sut(REPO_ROOT);

        // Assert
        expect(result).toEqual([]);
      });
    });
  });
});

describe('formatDetachedStanza', () => {
  describe('Given a detached doc comment, When it is formatted', () => {
    it('Then the stanza names the file, the line and the repair', () => {
      // Arrange
      const sut = formatDetachedStanza;

      // Act
      const result = sut({ file: 'src/example.ts', line: 42 });

      // Assert
      expect(result).toContain('src/example.ts:42');
      expect(result).toContain('Move it above the declaration it documents');
    });
  });
});
