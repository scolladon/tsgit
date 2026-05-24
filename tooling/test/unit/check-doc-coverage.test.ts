import * as path from 'node:path';
import * as url from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  checkDocsExist,
  checkIndexRow,
  formatGapStanza,
  kebabCase,
  parseAllowList,
  parseRepositoryInterface,
  runCheck,
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
    const sut = parseRepositoryInterface(source);

    // Assert
    expect(sut).toEqual({
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
    const sut = parseRepositoryInterface(source);

    // Assert
    expect(sut.primitives).toEqual([]);
    expect(sut.commands).toEqual(['add']);
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
    const sut = parseRepositoryInterface(source);

    // Assert
    expect(sut.commands).toEqual([]);
    expect(sut.primitives).toEqual([]);
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
    const sut = parseRepositoryInterface(source);

    // Assert
    expect(sut.commands).toEqual(['add']);
  });
    });
  });
});

describe('kebabCase', () => {
  describe("Given a single-word camel case", () => {
    describe("When kebab-cased", () => {
      it('Then the same lower-case word is returned', () => {
    // Arrange + Act
    const sut = kebabCase('clone');

    // Assert
    expect(sut).toBe('clone');
  });
    });
  });

  describe("Given catFile", () => {
    describe("When kebab-cased", () => {
      it('Then cat-file', () => {
    // Arrange + Act
    const sut = kebabCase('catFile');

    // Assert
    expect(sut).toBe('cat-file');
  });
    });
  });

  describe("Given revParse", () => {
    describe("When kebab-cased", () => {
      it('Then rev-parse', () => {
    // Arrange + Act
    const sut = kebabCase('revParse');

    // Assert
    expect(sut).toBe('rev-parse');
  });
    });
  });

  describe("Given fetchMissing", () => {
    describe("When kebab-cased", () => {
      it('Then fetch-missing', () => {
    // Arrange + Act
    const sut = kebabCase('fetchMissing');

    // Assert
    expect(sut).toBe('fetch-missing');
  });
    });
  });

  describe("Given sparseCheckout", () => {
    describe("When kebab-cased", () => {
      it('Then sparse-checkout', () => {
    // Arrange + Act
    const sut = kebabCase('sparseCheckout');

    // Assert
    expect(sut).toBe('sparse-checkout');
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
    const sut = checkDocsExist('commands', ['clone'], '/docs', [], fileExists);

    // Assert
    expect(sut).toEqual([]);
  });
    });
  });

  describe("Given a docs root missing the expected file", () => {
    describe("When checkDocsExist runs", () => {
      it('Then one gap is returned with the missing path', () => {
    // Arrange
    const fileExists = (): boolean => false;

    // Act
    const sut = checkDocsExist('commands', ['clone'], '/docs', [], fileExists);

    // Assert
    expect(sut).toEqual([
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
    const sut = checkDocsExist('commands', ['clone'], '/docs', ['clone'], fileExists);

    // Assert
    expect(sut).toEqual([]);
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
    const sut = checkDocsExist('commands', ['clone', 'add', 'commit'], '/docs', [], fileExists);

    // Assert
    expect(sut.map((g) => g.name)).toEqual(['add', 'commit']);
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
    const sut = checkIndexRow('commands', ['clone'], '/docs', [], readFile);

    // Assert
    expect(sut).toEqual([]);
  });
    });
  });

  describe("Given a README missing the expected row", () => {
    describe("When checkIndexRow runs", () => {
      it('Then one gap is returned', () => {
    // Arrange
    const readFile = (): string => 'no entries here';

    // Act
    const sut = checkIndexRow('commands', ['clone'], '/docs', [], readFile);

    // Assert
    expect(sut).toEqual([
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
    const sut = checkIndexRow('commands', ['clone', 'add'], '/docs', [], readFile);

    // Assert
    expect(sut.map((g) => g.name)).toEqual(['clone', 'add']);
    expect(sut.every((g) => g.missing === 'index-row')).toBe(true);
  });
    });
  });

  describe("Given a name in the allowlist", () => {
    describe("When checkIndexRow runs against a README missing that row", () => {
      it('Then no gap is returned', () => {
    // Arrange
    const readFile = (): string => '';

    // Act
    const sut = checkIndexRow('commands', ['clone'], '/docs', ['clone'], readFile);

    // Assert
    expect(sut).toEqual([]);
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
    const sut = formatGapStanza(gap);

    // Assert
    expect(sut).toContain('ERROR /repo/docs/use/commands/clone.md missing');
    expect(sut).toContain('Surface symbol: repo.clone');
    expect(sut).toContain('[`clone`](clone.md)');
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
    const sut = formatGapStanza(gap);

    // Assert
    expect(sut).toContain('Surface symbol: repo.primitives.readObject');
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
    const sut = formatGapStanza(gap);

    // Assert
    expect(sut).toContain('missing index row for `clone`');
    expect(sut).toContain('/repo/docs/use/commands/clone.md');
  });
    });
  });
});

describe('runCheck against the real repo', () => {
  describe("Given the live repository.ts + docs tree", () => {
    describe("When runCheck runs", () => {
      it('Then no gaps are reported', () => {
    // Arrange + Act
    const sut = runCheck(REPO_ROOT);

    // Assert
    expect(sut).toEqual([]);
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
    const sut = parseAllowList(raw);

    // Assert
    expect(sut).toEqual({ commands: ['clone'], primitives: ['readObject'] });
  });
    });
  });

  describe("Given JSON whose commands is a non-array", () => {
    describe("When parsed", () => {
      it('Then commands defaults to empty', () => {
    // Arrange
    const raw = JSON.stringify({ commands: 'oops', primitives: [] });

    // Act
    const sut = parseAllowList(raw);

    // Assert
    expect(sut.commands).toEqual([]);
  });
    });
  });

  describe("Given JSON whose entries contain non-strings", () => {
    describe("When parsed", () => {
      it('Then non-strings are filtered out', () => {
    // Arrange
    const raw = JSON.stringify({ commands: ['clone', 42, null, 'add'], primitives: [] });

    // Act
    const sut = parseAllowList(raw);

    // Assert
    expect(sut.commands).toEqual(['clone', 'add']);
  });
    });
  });

  describe("Given malformed JSON", () => {
    describe("When parsed", () => {
      it('Then both lists default to empty', () => {
    // Arrange
    const raw = '{ not valid json';

    // Act
    const sut = parseAllowList(raw);

    // Assert
    expect(sut).toEqual({ commands: [], primitives: [] });
  });
    });
  });

  describe("Given JSON parsing to a non-object value (e.g. an array)", () => {
    describe("When parsed", () => {
      it('Then both lists default to empty', () => {
    // Arrange
    const raw = JSON.stringify(['just', 'an', 'array']);

    // Act
    const sut = parseAllowList(raw);

    // Assert
    expect(sut).toEqual({ commands: [], primitives: [] });
  });
    });
  });

  describe("Given JSON parsing to null", () => {
    describe("When parsed", () => {
      it('Then both lists default to empty', () => {
    // Arrange
    const raw = 'null';

    // Act
    const sut = parseAllowList(raw);

    // Assert
    expect(sut).toEqual({ commands: [], primitives: [] });
  });
    });
  });
});
