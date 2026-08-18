import { describe, expect, it } from 'vitest';
import { isRefsLinkText, isValidHeadContent } from '../../../../src/domain/repository/head-ref.js';

describe('isValidHeadContent', () => {
  describe('Given content is a symbolic ref with a space and a trailing newline', () => {
    describe('When isValidHeadContent runs', () => {
      it('Then it returns true', () => {
        // Arrange
        const sut = isValidHeadContent;

        // Act
        const result = sut('ref: refs/heads/main\n');

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given content is a symbolic ref with no trailing newline', () => {
    describe('When isValidHeadContent runs', () => {
      it('Then it returns true', () => {
        // Arrange
        const sut = isValidHeadContent;

        // Act
        const result = sut('ref: refs/heads/main');

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given content is a symbolic ref with no space after the ref: prefix', () => {
    describe('When isValidHeadContent runs', () => {
      it('Then it returns true', () => {
        // Arrange
        const sut = isValidHeadContent;

        // Act
        const result = sut('ref:refs/heads/main\n');

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given content is a symbolic ref with several spaces after the ref: prefix', () => {
    describe('When isValidHeadContent runs', () => {
      it('Then it returns true', () => {
        // Arrange
        const sut = isValidHeadContent;

        // Act
        const result = sut('ref:    refs/heads/main\n');

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given content is a symbolic ref whose refname contains a directory-traversal segment', () => {
    describe('When isValidHeadContent runs', () => {
      it('Then it returns true because the refname is not format-checked', () => {
        // Arrange
        const sut = isValidHeadContent;

        // Act
        const result = sut('ref: refs/heads/../evil\n');

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given content is 40 lowercase hex characters', () => {
    describe('When isValidHeadContent runs', () => {
      it('Then it returns true for a detached SHA-1-width HEAD', () => {
        // Arrange
        const sut = isValidHeadContent;

        // Act
        const result = sut('a'.repeat(40));

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given content is 64 lowercase hex characters', () => {
    describe('When isValidHeadContent runs', () => {
      it('Then it returns true for a detached SHA-256-width HEAD', () => {
        // Arrange
        const sut = isValidHeadContent;

        // Act
        const result = sut('a'.repeat(64));

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given content is 40 lowercase hex characters with a trailing newline', () => {
    describe('When isValidHeadContent runs', () => {
      it('Then it returns true — real git always writes a detached HEAD this way', () => {
        // Arrange
        const sut = isValidHeadContent;

        // Act
        const result = sut(`${'a'.repeat(40)}\n`);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given content is 64 lowercase hex characters with a trailing newline', () => {
    describe('When isValidHeadContent runs', () => {
      it('Then it returns true', () => {
        // Arrange
        const sut = isValidHeadContent;

        // Act
        const result = sut(`${'a'.repeat(64)}\n`);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given content is 40 lowercase hex characters followed by trailing garbage', () => {
    describe('When isValidHeadContent runs', () => {
      it('Then it returns true because git parses the leading object id and ignores the remainder', () => {
        // Arrange
        const sut = isValidHeadContent;

        // Act
        const result = sut(`${'a'.repeat(40)}not-hex-at-all`);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given content is 40 lowercase hex characters with a CRLF terminator', () => {
    describe('When isValidHeadContent runs', () => {
      it('Then it returns true through the same leading-prefix rule', () => {
        // Arrange
        const sut = isValidHeadContent;

        // Act
        const result = sut(`${'a'.repeat(40)}\r\n`);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given content is 40 UPPERCASE hex characters', () => {
    describe('When isValidHeadContent runs', () => {
      it('Then it returns true because git accepts both cases in an object id', () => {
        // Arrange
        const sut = isValidHeadContent;

        // Act
        const result = sut('A'.repeat(40));

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a full object id preceded by leading garbage', () => {
    describe('When isValidHeadContent runs', () => {
      it('Then it returns false because the id must LEAD the content', () => {
        // Arrange
        const sut = isValidHeadContent;

        // Act
        const result = sut(`zz${'a'.repeat(40)}`);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a symbolic ref preceded by leading garbage', () => {
    describe('When isValidHeadContent runs', () => {
      it('Then it returns false because the ref: prefix must LEAD the content', () => {
        // Arrange
        const sut = isValidHeadContent;

        // Act
        const result = sut('x ref: refs/heads/main');

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given content is 39 lowercase hex characters', () => {
    describe('When isValidHeadContent runs', () => {
      it('Then it returns false because a full object id never materialises', () => {
        // Arrange
        const sut = isValidHeadContent;

        // Act
        const result = sut('a'.repeat(39));

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given content is ref: followed by a no-break space and a refs/ name', () => {
    describe('When isValidHeadContent runs', () => {
      it('Then it returns false because only ASCII whitespace separates the prefix', () => {
        // Arrange
        const sut = isValidHeadContent;

        // Act
        const result = sut('ref:\u00A0refs/heads/main\n');

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given content is ref: followed by a token beginning refs but not refs/', () => {
    describe('When isValidHeadContent runs', () => {
      it('Then it returns false because the namespace prefix requires its slash', () => {
        // Arrange
        const sut = isValidHeadContent;

        // Act
        const result = sut('ref: refsfoo\n');

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given content is ref: followed by a single-level name with no refs/ prefix', () => {
    describe('When isValidHeadContent runs', () => {
      it('Then it returns false', () => {
        // Arrange
        const sut = isValidHeadContent;

        // Act
        const result = sut('ref: main\n');

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given content is 40 non-hex characters', () => {
    describe('When isValidHeadContent runs', () => {
      it('Then it returns false', () => {
        // Arrange
        const sut = isValidHeadContent;

        // Act
        const result = sut('z'.repeat(40));

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given content is empty', () => {
    describe('When isValidHeadContent runs', () => {
      it('Then it returns false', () => {
        // Arrange
        const sut = isValidHeadContent;

        // Act
        const result = sut('');

        // Assert
        expect(result).toBe(false);
      });
    });
  });
});

describe('isRefsLinkText', () => {
  describe('Given link text with forward slashes into refs/', () => {
    describe('When isRefsLinkText runs', () => {
      it('Then it qualifies', () => {
        // Arrange
        const sut = isRefsLinkText;

        // Act
        const result = sut('refs/heads/main');

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given Windows link text with backslashes into refs', () => {
    describe('When isRefsLinkText runs', () => {
      it('Then separators are normalised and it still qualifies', () => {
        // Arrange
        const sut = isRefsLinkText;

        // Act
        const result = sut('refs\\heads\\main');

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given link text pointing outside refs', () => {
    describe('When isRefsLinkText runs', () => {
      it('Then it does not qualify on either separator style', () => {
        // Arrange
        const sut = isRefsLinkText;

        // Act
        const posix = sut('/nowhere/else');
        const windows = sut('C:\\nowhere\\else');

        // Assert
        expect(posix).toBe(false);
        expect(windows).toBe(false);
      });
    });
  });
});
