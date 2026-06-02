import { describe, expect, it } from 'vitest';

import { FILE_MODE, type ObjectId } from '../../../../src/domain/objects/index.js';
import { renderTreeListing } from '../../../../src/domain/show/render-tree.js';

const OID = '0000000000000000000000000000000000000000' as ObjectId;
const entry = (name: string, mode: (typeof FILE_MODE)[keyof typeof FILE_MODE]) => ({
  name,
  mode,
  id: OID,
});

describe('renderTreeListing', () => {
  describe('Given a tree with a file and a sub-directory, When renderTreeListing runs', () => {
    it('Then the header echoes the input and the sub-tree gets a slash', () => {
      // Arrange
      const entries = [entry('a.txt', FILE_MODE.REGULAR), entry('sub', FILE_MODE.DIRECTORY)];

      // Act
      const sut = renderTreeListing('HEAD^{tree}', entries);

      // Assert
      expect(sut).toBe('tree HEAD^{tree}\n\na.txt\nsub/\n');
    });
  });

  describe('Given a raw oid as the input name, When renderTreeListing runs', () => {
    it('Then the header echoes the oid verbatim', () => {
      // Arrange
      const entries = [entry('a.txt', FILE_MODE.REGULAR)];

      // Act
      const sut = renderTreeListing('ae7617af6291aabc261ad7f1f06d54044b943043', entries);

      // Assert
      expect(sut).toBe('tree ae7617af6291aabc261ad7f1f06d54044b943043\n\na.txt\n');
    });
  });

  describe('Given symlink, gitlink and executable entries, When renderTreeListing runs', () => {
    it('Then only directories get a trailing slash', () => {
      // Arrange
      const entries = [
        entry('link', FILE_MODE.SYMLINK),
        entry('mod', FILE_MODE.GITLINK),
        entry('run', FILE_MODE.EXECUTABLE),
      ];

      // Act
      const sut = renderTreeListing('t', entries);

      // Assert
      expect(sut).toBe('tree t\n\nlink\nmod\nrun\n');
    });
  });

  describe('Given an empty tree, When renderTreeListing runs', () => {
    it('Then only the header and a blank line are emitted', () => {
      // Arrange
      const entries: ReadonlyArray<ReturnType<typeof entry>> = [];

      // Act
      const sut = renderTreeListing('empty', entries);

      // Assert
      expect(sut).toBe('tree empty\n\n');
    });
  });
});
