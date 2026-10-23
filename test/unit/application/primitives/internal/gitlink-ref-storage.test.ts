import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { refStorageOf } from '../../../../../src/application/primitives/internal/gitlink-ref-storage.js';

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
      label: 'lower-cased section and key',
      config: '[CORE]\n\tRepositoryFormatVersion = 1\n[EXTENSIONS]\n\trefstorage = reftable\n',
      expected: 'reftable',
    },
    {
      label: 'format version 0 declaring reftable',
      config: '[core]\n\trepositoryformatversion = 0\n[extensions]\n\trefStorage = reftable\n',
      expected: 'files',
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
    {
      label: 'reftable declared under a subsection',
      config: '[core]\n\trepositoryformatversion = 1\n[extensions "x"]\n\trefStorage = reftable\n',
      expected: 'files',
    },
    {
      label: 'a valueless refStorage',
      config: '[core]\n\trepositoryformatversion = 1\n[extensions]\n\trefStorage\n',
      expected: 'files',
    },
    {
      label: 'a valueless format version',
      config: '[core]\n\trepositoryformatversion\n[extensions]\n\trefStorage = reftable\n',
      expected: 'files',
    },
  ])('Given $label', ({ config, expected }) => {
    describe('When the declared ref storage is read', () => {
      it(`Then it is ${'$expected'}`, async () => {
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
