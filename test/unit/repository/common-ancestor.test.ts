import { describe, expect, it } from 'vitest';
import { posixPolicy, windowsPolicy } from '../../../src/adapters/node/path-policy.js';
import { commonAncestor } from '../../../src/repository/common-ancestor.js';

describe('commonAncestor', () => {
  describe('Given a path and a sibling', () => {
    describe('When commonAncestor runs', () => {
      it('Then it returns the shared parent', () => {
        // Arrange
        const sut = commonAncestor;
        const paths = ['/tmp/repo', '/tmp/repo-wt'];

        // Act
        const result = sut(paths, posixPolicy);

        // Assert
        expect(result).toBe('/tmp');
      });
    });
  });

  describe('Given a path and its descendant', () => {
    describe('When commonAncestor runs', () => {
      it('Then it returns the ancestor itself', () => {
        // Arrange
        const sut = commonAncestor;
        const paths = ['/a/b', '/a/b/c/d'];

        // Act
        const result = sut(paths, posixPolicy);

        // Assert
        expect(result).toBe('/a/b');
      });
    });
  });

  describe('Given paths sharing no prefix', () => {
    describe('When commonAncestor runs', () => {
      it('Then it returns the root', () => {
        // Arrange
        const sut = commonAncestor;
        const paths = ['/a/x', '/b/y'];

        // Act
        const result = sut(paths, posixPolicy);

        // Assert
        expect(result).toBe('/');
      });
    });
  });

  describe('Given a single path', () => {
    describe('When commonAncestor runs', () => {
      it('Then it returns that path', () => {
        // Arrange
        const sut = commonAncestor;
        const paths = ['/a/b/c'];

        // Act
        const result = sut(paths, posixPolicy);

        // Assert
        expect(result).toBe('/a/b/c');
      });
    });
  });

  describe('Given no paths', () => {
    describe('When commonAncestor runs', () => {
      it('Then it returns the root', () => {
        // Arrange
        const sut = commonAncestor;
        const paths: ReadonlyArray<string> = [];

        // Act
        const result = sut(paths, posixPolicy);

        // Assert
        expect(result).toBe('/');
      });
    });
  });

  describe('Given a Windows drive path and a sibling', () => {
    describe('When commonAncestor runs', () => {
      it('Then it returns the shared drive parent', () => {
        // Arrange
        const sut = commonAncestor;
        const paths = ['C:\\repo', 'C:\\repo\\wt'];

        // Act
        const result = sut(paths, windowsPolicy);

        // Assert
        expect(result).toBe('C:\\repo');
      });
    });
  });

  describe('Given two Windows paths sharing a deeper common directory', () => {
    describe('When commonAncestor runs', () => {
      it('Then it returns that deeper shared directory', () => {
        // Arrange
        const sut = commonAncestor;
        const paths = ['C:\\Users\\me\\repo', 'C:\\Users\\me\\feature'];

        // Act
        const result = sut(paths, windowsPolicy);

        // Assert
        expect(result).toBe('C:\\Users\\me');
      });
    });
  });

  describe('Given a Windows path and its descendant', () => {
    describe('When commonAncestor runs', () => {
      it('Then it returns the ancestor itself', () => {
        // Arrange
        const sut = commonAncestor;
        const paths = ['C:\\a\\b', 'C:\\a\\b\\c\\d'];

        // Act
        const result = sut(paths, windowsPolicy);

        // Assert
        expect(result).toBe('C:\\a\\b');
      });
    });
  });

  describe('Given a Windows descendant listed before its ancestor', () => {
    describe('When commonAncestor runs', () => {
      it('Then it returns the ancestor without throwing on the shorter path', () => {
        // Arrange
        const sut = commonAncestor;
        const paths = ['C:\\a\\b\\c', 'C:\\a\\b'];

        // Act
        const result = sut(paths, windowsPolicy);

        // Assert
        expect(result).toBe('C:\\a\\b');
      });
    });
  });

  describe('Given two Windows paths differing only by case', () => {
    describe('When commonAncestor runs', () => {
      it('Then it compares case-insensitively and emits the first input’s original casing', () => {
        // Arrange
        const sut = commonAncestor;
        const paths = ['C:\\Repo', 'c:\\repo\\wt'];

        // Act
        const result = sut(paths, windowsPolicy);

        // Assert
        expect(result).toBe('C:\\Repo');
      });
    });
  });

  describe('Given Windows paths mixing forward and backward slashes', () => {
    describe('When commonAncestor runs', () => {
      it('Then it resolves both to native separators before comparing', () => {
        // Arrange
        const sut = commonAncestor;
        const paths = ['C:/Users/me/repo', 'C:\\Users\\me\\repo\\wt'];

        // Act
        const result = sut(paths, windowsPolicy);

        // Assert
        expect(result).toBe('C:\\Users\\me\\repo');
      });
    });
  });

  describe('Given Windows paths on different drives', () => {
    describe('When commonAncestor runs', () => {
      it('Then it returns the resolved first input, not the drive root', () => {
        // Arrange
        const sut = commonAncestor;
        const paths = ['C:\\a', 'D:\\b'];

        // Act
        const result = sut(paths, windowsPolicy);

        // Assert
        expect(result).toBe('C:\\a');
      });
    });
  });

  describe('Given UNC paths on the same share', () => {
    describe('When commonAncestor runs', () => {
      it('Then it returns the shared UNC directory', () => {
        // Arrange
        const sut = commonAncestor;
        const paths = ['\\\\srv\\share\\repo', '\\\\srv\\share\\repo\\wt'];

        // Act
        const result = sut(paths, windowsPolicy);

        // Assert
        expect(result).toBe('\\\\srv\\share\\repo');
      });
    });
  });

  describe('Given a single Windows path', () => {
    describe('When commonAncestor runs', () => {
      it('Then it returns that path unchanged', () => {
        // Arrange
        const sut = commonAncestor;
        const paths = ['C:\\a\\b\\c'];

        // Act
        const result = sut(paths, windowsPolicy);

        // Assert
        expect(result).toBe('C:\\a\\b\\c');
      });
    });
  });

  describe('Given no paths and a Windows policy', () => {
    describe('When commonAncestor runs', () => {
      it('Then it returns the Windows separator', () => {
        // Arrange
        const sut = commonAncestor;
        const paths: ReadonlyArray<string> = [];

        // Act
        const result = sut(paths, windowsPolicy);

        // Assert
        expect(result).toBe('\\');
      });
    });
  });

  describe('Given UNC paths on different shares', () => {
    describe('When commonAncestor runs', () => {
      it('Then it returns the resolved first input, not the server root', () => {
        // Arrange
        const sut = commonAncestor;
        const paths = ['\\\\srv\\a\\x', '\\\\srv\\b\\y'];

        // Act
        const result = sut(paths, windowsPolicy);

        // Assert
        expect(result).toBe('\\\\srv\\a\\x');
      });
    });
  });
});
