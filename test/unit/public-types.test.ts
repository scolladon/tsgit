import { expectTypeOf } from 'expect-type';
import { describe, expect, it } from 'vitest';
import type {
  FilePath as FilePathBrowser,
  MergeBaseOptions as MergeBaseOptionsBrowser,
  ObjectId as ObjectIdBrowser,
  Pathspec as PathspecBrowser,
  RefName as RefNameBrowser,
  RepositoryConfig as RepositoryConfigBrowser,
  SnapshotOptions as SnapshotOptionsBrowser,
  TreeDiff as TreeDiffBrowser,
} from '../../src/index.browser.js';
import type {
  FilePath as FilePathDefault,
  MergeBaseOptions as MergeBaseOptionsDefault,
  ObjectId as ObjectIdDefault,
  Pathspec as PathspecDefault,
  RefName as RefNameDefault,
  RepositoryConfig as RepositoryConfigDefault,
  SnapshotOptions as SnapshotOptionsDefault,
  TreeDiff as TreeDiffDefault,
} from '../../src/index.default.js';
import type {
  FilePath as FilePathCore,
  MergeBaseOptions as MergeBaseOptionsCore,
  ObjectId as ObjectIdCore,
  Pathspec as PathspecCore,
  RefName as RefNameCore,
  RepositoryConfig as RepositoryConfigCore,
  SnapshotOptions as SnapshotOptionsCore,
  TreeDiff as TreeDiffCore,
} from '../../src/index.js';
import type {
  AuthorIdentity,
  BranchNamespace,
  CommandRunner,
  Commit,
  ConfigUserIdentity,
  Context,
  FilePath,
  FileSystem,
  MergeBaseOptions,
  ObjectId,
  OpenRepositoryOptions,
  Pathspec,
  RefName,
  Repository,
  RepositoryConfig,
  SnapshotFactory,
  SnapshotOptions,
  StatTreeDiff,
  StatusResult,
  TreeDiff,
} from '../../src/index.node.js';
import {
  FilePath as FilePathValue,
  ObjectId as ObjectIdValue,
  RefName as RefNameValue,
} from '../../src/index.node.js';

describe('public type surface', () => {
  describe('Given branded ids exported from index.node', () => {
    describe('When type-checked', () => {
      it('Then ObjectId, RefName, FilePath are never-free', () => {
        // Arrange + Assert
        expectTypeOf<ObjectId>().not.toBeNever();
        expectTypeOf<RefName>().not.toBeNever();
        expectTypeOf<FilePath>().not.toBeNever();
      });
    });
  });

  describe('Given diff shapes exported from index.node', () => {
    describe('When type-checked', () => {
      it('Then TreeDiff and StatTreeDiff are never-free', () => {
        // Arrange + Assert
        expectTypeOf<TreeDiff>().not.toBeNever();
        expectTypeOf<StatTreeDiff>().not.toBeNever();
      });
    });
  });

  describe('Given port types exported from index.node', () => {
    describe('When type-checked', () => {
      it('Then RepositoryConfig and Context are never-free with expected fields', () => {
        // Arrange + Assert
        expectTypeOf<RepositoryConfig>().not.toBeNever();
        expectTypeOf<Context>().not.toBeNever();
        expectTypeOf<RepositoryConfig>().toHaveProperty('user');
      });
    });
  });

  describe('Given orphan types exported from index.node', () => {
    describe('When type-checked', () => {
      it('Then MergeBaseOptions and Pathspec are never-free', () => {
        // Arrange + Assert
        expectTypeOf<MergeBaseOptions>().not.toBeNever();
        expectTypeOf<Pathspec>().not.toBeNever();
      });
    });
  });

  describe('Given the CommandRunner port type exported from index.node', () => {
    describe('When type-checked', () => {
      it('Then CommandRunner is never-free', () => {
        // Arrange + Assert
        expectTypeOf<CommandRunner>().not.toBeNever();
      });
    });
  });

  describe('Given a deep port-closure type exported from index.node', () => {
    describe('When type-checked', () => {
      it('Then FileSystem is never-free', () => {
        // Arrange + Assert
        expectTypeOf<FileSystem>().not.toBeNever();
      });
    });
  });

  describe('Given a git-object-union type exported from index.node', () => {
    describe('When type-checked', () => {
      it('Then Commit is never-free', () => {
        // Arrange + Assert
        expectTypeOf<Commit>().not.toBeNever();
      });
    });
  });

  describe('Given both author-identity shapes exported from index.node', () => {
    describe('When type-checked', () => {
      it('Then AuthorIdentity is the commit/tag identity and ConfigUserIdentity the distinct config-user shape', () => {
        // Arrange + Assert
        expectTypeOf<AuthorIdentity>().toHaveProperty('timestamp');
        expectTypeOf<ConfigUserIdentity>().toHaveProperty('email');
        expectTypeOf<ConfigUserIdentity>().not.toEqualTypeOf<AuthorIdentity>();
      });
    });
  });

  describe('Given namespace types exported from index.node', () => {
    describe('When type-checked', () => {
      it('Then BranchNamespace is never-free', () => {
        // Arrange + Assert
        expectTypeOf<BranchNamespace>().not.toBeNever();
      });
    });
  });

  describe('Given snapshot types exported from index.node', () => {
    describe('When type-checked', () => {
      it('Then SnapshotFactory and SnapshotOptions are never-free', () => {
        // Arrange + Assert
        expectTypeOf<SnapshotFactory>().not.toBeNever();
        expectTypeOf<SnapshotOptions>().not.toBeNever();
      });
    });
  });

  describe('Given command result types exported from index.node', () => {
    describe('When type-checked', () => {
      it('Then StatusResult is never-free', () => {
        // Arrange + Assert
        expectTypeOf<StatusResult>().not.toBeNever();
      });
    });
  });

  describe('Given edge-matrix (ii): entry-owned names from index.node', () => {
    describe('When type-checked', () => {
      it('Then Repository and OpenRepositoryOptions resolve to their entry-owned declarations', () => {
        // Arrange + Assert
        expectTypeOf<Repository>().toHaveProperty('status');
        expectTypeOf<Repository>().toHaveProperty('commit');
        expectTypeOf<OpenRepositoryOptions>().toHaveProperty('fs');
      });
    });
  });

  describe('Given representative types exported from index.browser', () => {
    describe('When type-checked', () => {
      it('Then the cross-section of types is never-free', () => {
        // Arrange + Assert
        expectTypeOf<ObjectIdBrowser>().not.toBeNever();
        expectTypeOf<RefNameBrowser>().not.toBeNever();
        expectTypeOf<FilePathBrowser>().not.toBeNever();
        expectTypeOf<TreeDiffBrowser>().not.toBeNever();
        expectTypeOf<RepositoryConfigBrowser>().not.toBeNever();
        expectTypeOf<MergeBaseOptionsBrowser>().not.toBeNever();
        expectTypeOf<PathspecBrowser>().not.toBeNever();
        expectTypeOf<SnapshotOptionsBrowser>().not.toBeNever();
      });
    });
  });

  describe('Given representative types exported from index.default', () => {
    describe('When type-checked', () => {
      it('Then the cross-section of types is never-free', () => {
        // Arrange + Assert
        expectTypeOf<ObjectIdDefault>().not.toBeNever();
        expectTypeOf<RefNameDefault>().not.toBeNever();
        expectTypeOf<FilePathDefault>().not.toBeNever();
        expectTypeOf<TreeDiffDefault>().not.toBeNever();
        expectTypeOf<RepositoryConfigDefault>().not.toBeNever();
        expectTypeOf<MergeBaseOptionsDefault>().not.toBeNever();
        expectTypeOf<PathspecDefault>().not.toBeNever();
        expectTypeOf<SnapshotOptionsDefault>().not.toBeNever();
      });
    });
  });

  describe('Given representative types exported from index.ts (core/module surface)', () => {
    describe('When type-checked', () => {
      it('Then the cross-section of types is never-free', () => {
        // Arrange + Assert
        expectTypeOf<ObjectIdCore>().not.toBeNever();
        expectTypeOf<RefNameCore>().not.toBeNever();
        expectTypeOf<FilePathCore>().not.toBeNever();
        expectTypeOf<TreeDiffCore>().not.toBeNever();
        expectTypeOf<RepositoryConfigCore>().not.toBeNever();
        expectTypeOf<MergeBaseOptionsCore>().not.toBeNever();
        expectTypeOf<PathspecCore>().not.toBeNever();
        expectTypeOf<SnapshotOptionsCore>().not.toBeNever();
      });
    });
  });

  describe('Given edge-matrix (iii): index.ts and index.node export the facade type set', () => {
    describe('When type-checked', () => {
      it('Then the cross-section is identical across both resolution surfaces', () => {
        // Arrange + Assert
        expectTypeOf<TreeDiffCore>().toEqualTypeOf<TreeDiff>();
        expectTypeOf<ObjectIdCore>().toEqualTypeOf<ObjectId>();
        expectTypeOf<RefNameCore>().toEqualTypeOf<RefName>();
        expectTypeOf<FilePathCore>().toEqualTypeOf<FilePath>();
        expectTypeOf<RepositoryConfigCore>().toEqualTypeOf<RepositoryConfig>();
        expectTypeOf<MergeBaseOptionsCore>().toEqualTypeOf<MergeBaseOptions>();
        expectTypeOf<PathspecCore>().toEqualTypeOf<Pathspec>();
        expectTypeOf<SnapshotOptionsCore>().toEqualTypeOf<SnapshotOptions>();
      });
    });
  });

  describe('Given ObjectId value constructor exported from index.node', () => {
    describe('When ObjectId.from is called with a valid SHA-1 hex string', () => {
      it('Then the returned branded value round-trips', () => {
        // Arrange
        const validSha = 'a'.repeat(40);

        // Act
        const result = ObjectIdValue.from(validSha);

        // Assert
        expect(result).toBe(validSha);
      });
    });

    describe('When ObjectId.from is called with an invalid string', () => {
      it('Then it throws with INVALID_OBJECT_ID and data.value === the input', () => {
        // Arrange
        const invalid = 'xyz';

        // Act / Assert
        try {
          ObjectIdValue.from(invalid);
          expect.fail('expected to throw');
        } catch (err: unknown) {
          expect((err as { data: { code: string; value: string } }).data.code).toBe(
            'INVALID_OBJECT_ID',
          );
          expect((err as { data: { code: string; value: string } }).data.value).toBe(invalid);
        }
      });
    });
  });

  describe('Given RefName value constructor exported from index.node', () => {
    describe('When RefName.from is called with a non-empty string', () => {
      it('Then the returned branded value round-trips', () => {
        // Arrange
        const name = 'refs/heads/main';

        // Act
        const result = RefNameValue.from(name);

        // Assert
        expect(result).toBe(name);
      });
    });
  });

  describe('Given FilePath value constructor exported from index.node', () => {
    describe('When FilePath.from is called with a non-empty string', () => {
      it('Then the returned branded value round-trips', () => {
        // Arrange
        const path = 'src/index.ts';

        // Act
        const result = FilePathValue.from(path);

        // Assert
        expect(result).toBe(path);
      });
    });
  });
});
