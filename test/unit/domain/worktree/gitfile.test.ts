import { describe, expect, it } from 'vitest';
import { parseCommondir, parseGitfilePointer } from '../../../../src/domain/worktree/gitfile.js';

const ABS_ADMIN_DIR = '/Users/dev/main/.git/worktrees/wt';
const RELATIVE_ADMIN_DIR = '../main/.git/worktrees/wt';

describe('gitfile pointer parsing', () => {
  describe('Given a gitdir pointer with an absolute path and a trailing newline', () => {
    describe('When parseGitfilePointer runs', () => {
      it('Then it resolves to ok with the path', () => {
        // Arrange + Act
        const result = parseGitfilePointer(`gitdir: ${ABS_ADMIN_DIR}\n`);

        // Assert
        expect(result).toEqual({ kind: 'ok', path: ABS_ADMIN_DIR });
      });
    });
  });

  describe('Given a gitdir pointer with a relative path', () => {
    describe('When parseGitfilePointer runs', () => {
      it("Then it keeps the path verbatim (resolution is not this parser's job)", () => {
        // Arrange + Act
        const result = parseGitfilePointer(`gitdir: ${RELATIVE_ADMIN_DIR}\n`);

        // Assert
        expect(result).toEqual({ kind: 'ok', path: RELATIVE_ADMIN_DIR });
      });
    });
  });

  describe('Given a gitdir pointer with no trailing newline', () => {
    describe('When parseGitfilePointer runs', () => {
      it('Then it still resolves to ok', () => {
        // Arrange + Act
        const result = parseGitfilePointer(`gitdir: ${ABS_ADMIN_DIR}`);

        // Assert
        expect(result).toEqual({ kind: 'ok', path: ABS_ADMIN_DIR });
      });
    });
  });

  describe('Given a gitdir pointer with trailing spaces before a CRLF', () => {
    describe('When parseGitfilePointer runs', () => {
      it('Then it keeps the trailing spaces in the path — only \\r/\\n are stripped', () => {
        // Arrange + Act
        const result = parseGitfilePointer(`gitdir: ${ABS_ADMIN_DIR}  \r\n`);

        // Assert
        expect(result).toEqual({ kind: 'ok', path: `${ABS_ADMIN_DIR}  ` });
      });
    });
  });

  describe('Given a gitdir pointer with leading whitespace before the prefix', () => {
    describe('When parseGitfilePointer runs', () => {
      it('Then it is invalid-format', () => {
        // Arrange + Act
        const result = parseGitfilePointer(`  gitdir: ${ABS_ADMIN_DIR}\n`);

        // Assert
        expect(result).toEqual({ kind: 'invalid-format' });
      });
    });
  });

  describe('Given a gitdir pointer missing the space after the colon', () => {
    describe('When parseGitfilePointer runs', () => {
      it('Then it is invalid-format', () => {
        // Arrange + Act
        const result = parseGitfilePointer(`gitdir:${ABS_ADMIN_DIR}\n`);

        // Assert
        expect(result).toEqual({ kind: 'invalid-format' });
      });
    });
  });

  describe('Given a gitdir pointer with an empty path', () => {
    describe('When parseGitfilePointer runs', () => {
      it('Then it is no-path', () => {
        // Arrange + Act
        const result = parseGitfilePointer('gitdir: \n');

        // Assert
        expect(result).toEqual({ kind: 'no-path' });
      });
    });
  });

  describe('Given a file with no gitdir prefix at all', () => {
    describe('When parseGitfilePointer runs', () => {
      it('Then it is invalid-format', () => {
        // Arrange + Act
        const result = parseGitfilePointer('hello world\n');

        // Assert
        expect(result).toEqual({ kind: 'invalid-format' });
      });
    });
  });

  describe('Given a gitdir pointer followed by extra junk on a second line', () => {
    describe('When parseGitfilePointer runs', () => {
      it('Then the whole remainder, embedded newline included, is the path', () => {
        // Arrange + Act
        const result = parseGitfilePointer(`gitdir: ${ABS_ADMIN_DIR}\nextra junk\n`);

        // Assert
        expect(result).toEqual({ kind: 'ok', path: `${ABS_ADMIN_DIR}\nextra junk` });
      });
    });
  });
});

describe('commondir value parsing', () => {
  describe('Given a commondir back-reference with a trailing newline', () => {
    describe('When parseCommondir runs', () => {
      it('Then it resolves to ok with the path', () => {
        // Arrange + Act
        const result = parseCommondir('../..\n');

        // Assert
        expect(result).toEqual({ kind: 'ok', path: '../..' });
      });
    });
  });

  describe('Given a commondir back-reference with no trailing newline', () => {
    describe('When parseCommondir runs', () => {
      it('Then it still resolves to ok', () => {
        // Arrange + Act
        const result = parseCommondir('../..');

        // Assert
        expect(result).toEqual({ kind: 'ok', path: '../..' });
      });
    });
  });

  describe('Given a commondir value that is an absolute path', () => {
    describe('When parseCommondir runs', () => {
      it('Then it resolves to ok with the absolute path', () => {
        // Arrange + Act
        const result = parseCommondir(`${ABS_ADMIN_DIR}\n`);

        // Assert
        expect(result).toEqual({ kind: 'ok', path: ABS_ADMIN_DIR });
      });
    });
  });

  describe('Given a commondir back-reference with trailing spaces', () => {
    describe('When parseCommondir runs', () => {
      it('Then it keeps the trailing spaces — only \\r/\\n are stripped', () => {
        // Arrange + Act
        const result = parseCommondir('../..  \n');

        // Assert
        expect(result).toEqual({ kind: 'ok', path: '../..  ' });
      });
    });
  });

  describe('Given a commondir file containing only a newline', () => {
    describe('When parseCommondir runs', () => {
      it('Then it is empty', () => {
        // Arrange + Act
        const result = parseCommondir('\n');

        // Assert
        expect(result).toEqual({ kind: 'empty' });
      });
    });
  });

  describe('Given a commondir file with no content at all', () => {
    describe('When parseCommondir runs', () => {
      it('Then it is empty', () => {
        // Arrange + Act
        const result = parseCommondir('');

        // Assert
        expect(result).toEqual({ kind: 'empty' });
      });
    });
  });
});
