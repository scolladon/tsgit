import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { init } from '../../../../../src/application/commands/init.js';
import {
  changedPathsRequest,
  resolveChangedPathsSettings,
} from '../../../../../src/application/primitives/internal/changed-paths-settings.js';
import type { CommitGraphBloomSettings } from '../../../../../src/domain/commit/commit-graph.js';
import type { TsgitError } from '../../../../../src/domain/error.js';
import type { Context } from '../../../../../src/ports/context.js';

const STORED_V2: CommitGraphBloomSettings = { hashVersion: 2, numHashes: 6, bitsPerEntry: 12 };
const STORED_V1: CommitGraphBloomSettings = { ...STORED_V2, hashVersion: 1 };

const contextWith = async (config: string): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.appendUtf8(`${ctx.layout.gitDir}/config`, `[commitGraph]\n${config}`);
  return ctx;
};

describe('resolveChangedPathsSettings', () => {
  describe.each([
    {
      label: 'a stored v2 graph and no configured version',
      config: '',
      stored: STORED_V2,
      expected: { hashVersion: 2, numHashes: 6, bitsPerEntry: 12, maxChangedPaths: 512 },
    },
    {
      label: 'a stored v1 graph and version 2 configured',
      config: '\tchangedPathsVersion = 2\n',
      stored: STORED_V1,
      expected: { hashVersion: 2, numHashes: 6, bitsPerEntry: 12, maxChangedPaths: 512 },
    },
    {
      label: 'a stored v2 graph and version 1 configured',
      config: '\tchangedPathsVersion = 1\n',
      stored: STORED_V2,
      expected: { hashVersion: 1, numHashes: 6, bitsPerEntry: 12, maxChangedPaths: 512 },
    },
    {
      label: 'a stored graph of an unknown hash version',
      config: '',
      stored: { ...STORED_V2, hashVersion: 7 },
      expected: { hashVersion: 1, numHashes: 6, bitsPerEntry: 12, maxChangedPaths: 512 },
    },
    {
      label: 'a stored graph and version 0 configured',
      config: '\tchangedPathsVersion = 0\n',
      stored: STORED_V2,
      expected: undefined,
    },
    {
      label: 'a stored graph and changed paths not read',
      config: '\treadChangedPaths = false\n',
      stored: STORED_V2,
      expected: undefined,
    },
    { label: 'no stored graph', config: '', stored: undefined, expected: undefined },
  ])('Given $label', ({ config, stored, expected }) => {
    describe('When the existing setting is preserved', () => {
      it('Then the stored settings carry over, the version unless configured', async () => {
        // Arrange
        const ctx = await contextWith(config);
        const sut = resolveChangedPathsSettings;

        // Act
        const result = await sut(ctx, stored, 'preserve');

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });

  describe.each([
    { label: 'no configured version', config: '', expected: 1 },
    { label: 'version 2 configured', config: '\tchangedPathsVersion = 2\n', expected: 2 },
  ])('Given no stored graph and $label', ({ config, expected }) => {
    describe('When changed paths are enabled', () => {
      it(`Then git's default settings apply at hash version ${expected}`, async () => {
        // Arrange
        const ctx = await contextWith(config);
        const sut = resolveChangedPathsSettings;

        // Act
        const result = await sut(ctx, undefined, 'enable');

        // Assert
        expect(result).toEqual({
          hashVersion: expected,
          numHashes: 7,
          bitsPerEntry: 10,
          maxChangedPaths: 512,
        });
      });
    });
  });
});

describe('changedPathsRequest', () => {
  describe.each([
    { label: 'commitGraph.changedPaths unset', config: '', expected: 'preserve' },
    {
      label: 'commitGraph.changedPaths true',
      config: '\tchangedPaths = true\n',
      expected: 'enable',
    },
    {
      label: 'a valueless commitGraph.changedPaths',
      config: '\tchangedPaths\n',
      expected: 'enable',
    },
    {
      label: 'commitGraph.changedPaths false',
      config: '\tchangedPaths = false\n',
      expected: 'preserve',
    },
  ])('Given $label', ({ config, expected }) => {
    describe('When read', () => {
      it(`Then the write is asked to ${expected}`, async () => {
        // Arrange
        const ctx = await contextWith(config);
        const sut = changedPathsRequest;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given a malformed commitGraph.changedPaths before a valid one', () => {
    describe('When read', () => {
      it('Then it refuses with the bad boolean, as git parses every entry', async () => {
        // Arrange
        const ctx = await contextWith('\tchangedPaths = maybe\n\tchangedPaths = true\n');
        const sut = changedPathsRequest;

        // Act
        const result = await sut(ctx).catch((error: TsgitError) => error.data);

        // Assert
        expect(result).toMatchObject({ code: 'CONFIG_BAD_BOOLEAN_VALUE', value: 'maybe' });
      });
    });
  });
});
