import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { refStorageOf } from '../../../../../src/application/primitives/internal/gitlink-ref-storage.js';
import { TsgitError } from '../../../../../src/domain/index.js';

const gitDirWithConfig = async (config: string | undefined) => {
  const { fs, layout } = createMemoryContext();
  const gitDir = `${layout.workDir}/sub/.git`;
  await fs.mkdir(gitDir);
  if (config !== undefined) await fs.writeUtf8(`${gitDir}/config`, config);
  return { fs, gitDir };
};

describe('refStorageOf', () => {
  describe.each([
    { label: 'no config file', config: undefined, expected: 'files' },
    {
      label: 'format version 1 declaring reftable',
      config: '[core]\n\trepositoryformatversion = 1\n[extensions]\n\trefStorage = reftable\n',
      expected: 'reftable',
    },
    {
      label: 'upper-cased section and key',
      config: '[CORE]\n\tRepositoryFormatVersion = 1\n[EXTENSIONS]\n\trefstorage = reftable\n',
      expected: 'reftable',
    },
    {
      label: 'no format version declaring reftable',
      config: '[extensions]\n\trefStorage = reftable\n',
      expected: 'files',
    },
    {
      label: 'format version 1 declaring files',
      config: '[core]\n\trepositoryformatversion = 1\n[extensions]\n\trefStorage = files\n',
      expected: 'files',
    },
    {
      label: 'format version 1 declaring nothing',
      config: '[core]\n\trepositoryformatversion = 1\n',
      expected: 'files',
    },
    {
      label: 'a later declaration of files after reftable',
      config:
        '[core]\n\trepositoryformatversion = 1\n[extensions]\n\trefStorage = reftable\n\trefStorage = files\n',
      expected: 'files',
    },
    {
      label: 'a later declaration of reftable after files',
      config:
        '[core]\n\trepositoryformatversion = 1\n[extensions]\n\trefStorage = files\n\trefStorage = reftable\n',
      expected: 'reftable',
    },
  ])('Given $label', ({ config, expected }) => {
    describe('When the declared ref storage is read', () => {
      it(`Then it is ${expected}`, async () => {
        // Arrange
        const { fs, gitDir } = await gitDirWithConfig(config);
        const sut = refStorageOf;

        // Act
        const storage = await sut(fs, gitDir);

        // Assert
        expect(storage).toBe(expected);
      });
    });
  });
});

const refusalOf = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (err) {
    if (err instanceof TsgitError) return err.data;
    throw err;
  }
  return undefined;
};

const VERSION_1 = '[core]\n\trepositoryformatversion = 1\n';

describe('refStorageOf over a repository format git refuses', () => {
  describe.each([
    {
      label: 'format version 1 declaring an unknown backend',
      config: `${VERSION_1}[extensions]\n\trefStorage = bogus\n`,
      refusal: {
        code: 'CONFIG_INVALID_ENUM_VALUE',
        key: 'extensions.refstorage',
        value: 'bogus',
        line: 4,
      },
    },
    {
      label: 'format version 1 declaring an empty backend',
      config: `${VERSION_1}[extensions]\n\trefStorage =\n`,
      refusal: {
        code: 'CONFIG_INVALID_ENUM_VALUE',
        key: 'extensions.refstorage',
        value: '',
        line: 4,
      },
    },
    {
      label: 'format version 1 declaring a backend in the wrong case',
      config: `${VERSION_1}[extensions]\n\trefStorage = Reftable\n`,
      refusal: {
        code: 'CONFIG_INVALID_ENUM_VALUE',
        key: 'extensions.refstorage',
        value: 'Reftable',
        line: 4,
      },
    },
    {
      label: 'no format version declaring an unknown backend',
      config: '[extensions]\n\trefStorage = bogus\n',
      refusal: {
        code: 'CONFIG_INVALID_ENUM_VALUE',
        key: 'extensions.refstorage',
        value: 'bogus',
        line: 2,
      },
    },
    {
      label: 'format version 0 declaring an unknown backend',
      config: '[core]\n\trepositoryformatversion = 0\n[extensions]\n\trefStorage = bogus\n',
      refusal: {
        code: 'CONFIG_INVALID_ENUM_VALUE',
        key: 'extensions.refstorage',
        value: 'bogus',
        line: 4,
      },
    },
    {
      label: 'format version 1 with a valueless refStorage',
      config: `${VERSION_1}[extensions]\n\trefStorage\n`,
      refusal: { code: 'CONFIG_MISSING_VALUE', key: 'extensions.refstorage', line: 4 },
    },
    {
      label: 'format version 0 with a valueless refStorage',
      config: '[core]\n\trepositoryformatversion = 0\n[extensions]\n\trefStorage\n',
      refusal: { code: 'CONFIG_MISSING_VALUE', key: 'extensions.refstorage', line: 4 },
    },
    {
      label: 'format version 0 declaring reftable',
      config: '[core]\n\trepositoryformatversion = 0\n[extensions]\n\trefStorage = reftable\n',
      refusal: {
        code: 'REPOSITORY_EXTENSIONS_UNSUPPORTED',
        version: 0,
        extensions: ['refstorage'],
      },
    },
    {
      label: 'format version 0 declaring files',
      config: '[core]\n\trepositoryformatversion = 0\n[extensions]\n\trefStorage = files\n',
      refusal: {
        code: 'REPOSITORY_EXTENSIONS_UNSUPPORTED',
        version: 0,
        extensions: ['refstorage'],
      },
    },
    {
      label: 'format version 2',
      config: '[core]\n\trepositoryformatversion = 2\n',
      refusal: { code: 'REPOSITORY_FORMAT_VERSION_UNSUPPORTED', version: 2 },
    },
    {
      label: 'format version 2 declaring reftable',
      config: '[core]\n\trepositoryformatversion = 2\n[extensions]\n\trefStorage = reftable\n',
      refusal: { code: 'REPOSITORY_FORMAT_VERSION_UNSUPPORTED', version: 2 },
    },
    {
      label: 'format version 1 with an unknown extension',
      config: `${VERSION_1}[extensions]\n\tbogus = x\n`,
      refusal: { code: 'REPOSITORY_EXTENSIONS_UNSUPPORTED', version: 1, extensions: ['bogus'] },
    },
    {
      label: 'format version 1 declaring reftable under a subsection',
      config: `${VERSION_1}[extensions "x"]\n\trefStorage = reftable\n`,
      refusal: {
        code: 'REPOSITORY_EXTENSIONS_UNSUPPORTED',
        version: 1,
        extensions: ['x.refstorage'],
      },
    },
    {
      label: 'format version 0 with another v1-only extension',
      config: '[core]\n\trepositoryformatversion = 0\n[extensions]\n\tobjectFormat = sha1\n',
      refusal: {
        code: 'REPOSITORY_EXTENSIONS_UNSUPPORTED',
        version: 0,
        extensions: ['objectformat'],
      },
    },
    {
      label: 'a valueless format version',
      config: '[core]\n\trepositoryformatversion\n[extensions]\n\trefStorage = reftable\n',
      refusal: {
        code: 'CONFIG_BAD_NUMERIC_VALUE',
        key: 'core.repositoryformatversion',
        value: '',
        reason: 'invalid unit',
      },
    },
  ])('Given $label', ({ config, refusal }) => {
    describe('When the declared ref storage is read', () => {
      it('Then it refuses with the error git reports, sourced at the config file', async () => {
        // Arrange
        const { fs, gitDir } = await gitDirWithConfig(config);
        const sut = refStorageOf;

        // Act
        const thrown = await refusalOf(() => sut(fs, gitDir));

        // Assert
        expect(thrown).toEqual(
          refusal.code.startsWith('CONFIG_') ? { ...refusal, source: `${gitDir}/config` } : refusal,
        );
      });
    });
  });
});
