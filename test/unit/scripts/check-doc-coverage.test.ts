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
} from '../../../scripts/check-doc-coverage.js';

const REPO_ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../..');

describe('parseRepositoryInterface', () => {
  it('Given a Repository interface with three commands and two primitives, When parsed, Then both name sets are returned', () => {
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

  it('Given a source with no primitives block, When parsed, Then primitives is empty', () => {
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

  it('Given a source where BindCtx is renamed, When parsed, Then both sets are empty', () => {
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

  it('Given the slot names primitives / ctx / dispose at the top level, When parsed, Then they are excluded from commands', () => {
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

describe('kebabCase', () => {
  it('Given a single-word camel case, When kebab-cased, Then the same lower-case word is returned', () => {
    // Arrange + Act
    const sut = kebabCase('clone');

    // Assert
    expect(sut).toBe('clone');
  });

  it('Given catFile, When kebab-cased, Then cat-file', () => {
    // Arrange + Act
    const sut = kebabCase('catFile');

    // Assert
    expect(sut).toBe('cat-file');
  });

  it('Given revParse, When kebab-cased, Then rev-parse', () => {
    // Arrange + Act
    const sut = kebabCase('revParse');

    // Assert
    expect(sut).toBe('rev-parse');
  });

  it('Given fetchMissing, When kebab-cased, Then fetch-missing', () => {
    // Arrange + Act
    const sut = kebabCase('fetchMissing');

    // Assert
    expect(sut).toBe('fetch-missing');
  });

  it('Given sparseCheckout, When kebab-cased, Then sparse-checkout', () => {
    // Arrange + Act
    const sut = kebabCase('sparseCheckout');

    // Assert
    expect(sut).toBe('sparse-checkout');
  });
});

describe('checkDocsExist', () => {
  it('Given a docs root with the expected file, When checkDocsExist runs, Then no gaps are returned', () => {
    // Arrange
    const expected = path.join('/docs', 'commands', 'clone.md');
    const fileExists = (p: string): boolean => p === expected;

    // Act
    const sut = checkDocsExist('commands', ['clone'], '/docs', [], fileExists);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given a docs root missing the expected file, When checkDocsExist runs, Then one gap is returned with the missing path', () => {
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

  it('Given a name in the allowlist, When checkDocsExist runs against a missing file, Then no gap is returned', () => {
    // Arrange
    const fileExists = (): boolean => false;

    // Act
    const sut = checkDocsExist('commands', ['clone'], '/docs', ['clone'], fileExists);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given multiple names, When some are missing and others exist, Then only the missing ones are reported', () => {
    // Arrange
    const expected = path.join('/docs', 'commands', 'clone.md');
    const fileExists = (p: string): boolean => p === expected;

    // Act
    const sut = checkDocsExist('commands', ['clone', 'add', 'commit'], '/docs', [], fileExists);

    // Assert
    expect(sut.map((g) => g.name)).toEqual(['add', 'commit']);
  });
});

describe('checkIndexRow', () => {
  it('Given a README containing the expected row, When checkIndexRow runs, Then no gap is returned', () => {
    // Arrange
    const readFile = (): string => '| [`clone`](clone.md) | Clone a remote |';

    // Act
    const sut = checkIndexRow('commands', ['clone'], '/docs', [], readFile);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given a README missing the expected row, When checkIndexRow runs, Then one gap is returned', () => {
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

  it('Given a README that cannot be read, When checkIndexRow runs, Then every name surfaces as an index-row gap', () => {
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

  it('Given a name in the allowlist, When checkIndexRow runs against a README missing that row, Then no gap is returned', () => {
    // Arrange
    const readFile = (): string => '';

    // Act
    const sut = checkIndexRow('commands', ['clone'], '/docs', ['clone'], readFile);

    // Assert
    expect(sut).toEqual([]);
  });
});

describe('formatGapStanza', () => {
  it('Given a missing-file gap, When formatted, Then the stanza names the expected file and index entry', () => {
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

  it('Given a primitives gap, When formatted, Then the surface symbol includes the primitives. prefix', () => {
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

  it('Given a missing-index-row gap, When formatted, Then the stanza names the README and the link target', () => {
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

describe('runCheck against the real repo', () => {
  it('Given the live repository.ts + docs tree, When runCheck runs, Then no gaps are reported', () => {
    // Arrange + Act
    const sut = runCheck(REPO_ROOT);

    // Assert
    expect(sut).toEqual([]);
  });

  it('Given a synthesised repository.ts with zero commands and zero primitives, When runCheck runs, Then it throws', () => {
    // Arrange
    const readSource = (): string => 'interface Repository {}';

    // Act + Assert
    expect(() => runCheck('/any/root', readSource)).toThrow(/zero commands AND zero primitives/);
  });
});

describe('parseAllowList', () => {
  it('Given a valid JSON object with both arrays, When parsed, Then both lists are returned', () => {
    // Arrange
    const raw = JSON.stringify({ commands: ['clone'], primitives: ['readObject'] });

    // Act
    const sut = parseAllowList(raw);

    // Assert
    expect(sut).toEqual({ commands: ['clone'], primitives: ['readObject'] });
  });

  it('Given JSON whose commands is a non-array, When parsed, Then commands defaults to empty', () => {
    // Arrange
    const raw = JSON.stringify({ commands: 'oops', primitives: [] });

    // Act
    const sut = parseAllowList(raw);

    // Assert
    expect(sut.commands).toEqual([]);
  });

  it('Given JSON whose entries contain non-strings, When parsed, Then non-strings are filtered out', () => {
    // Arrange
    const raw = JSON.stringify({ commands: ['clone', 42, null, 'add'], primitives: [] });

    // Act
    const sut = parseAllowList(raw);

    // Assert
    expect(sut.commands).toEqual(['clone', 'add']);
  });

  it('Given malformed JSON, When parsed, Then both lists default to empty', () => {
    // Arrange
    const raw = '{ not valid json';

    // Act
    const sut = parseAllowList(raw);

    // Assert
    expect(sut).toEqual({ commands: [], primitives: [] });
  });

  it('Given JSON parsing to a non-object value (e.g. an array), When parsed, Then both lists default to empty', () => {
    // Arrange
    const raw = JSON.stringify(['just', 'an', 'array']);

    // Act
    const sut = parseAllowList(raw);

    // Assert
    expect(sut).toEqual({ commands: [], primitives: [] });
  });

  it('Given JSON parsing to null, When parsed, Then both lists default to empty', () => {
    // Arrange
    const raw = 'null';

    // Act
    const sut = parseAllowList(raw);

    // Assert
    expect(sut).toEqual({ commands: [], primitives: [] });
  });
});
