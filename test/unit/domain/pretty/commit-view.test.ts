import { describe, expect, it } from 'vitest';
import { parseCommitView } from '../../../../src/domain/pretty/commit-view.js';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array | undefined): string | undefined =>
  bytes === undefined ? undefined : new TextDecoder().decode(bytes);

const TREE = 'f3d80e15d4aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PARENT_A = 'd948d406d8bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const PARENT_B = '1111111111111111111111111111111111111111';
const AUTHOR = 'A U Thor <author@example.com> 1700000200 +0545';
const COMMITTER = 'C O Mitter <committer@example.com> 1700000300 +0000';

const commit = (headers: ReadonlyArray<string>, message: string): Uint8Array =>
  encode(`${headers.join('\n')}\n\n${message}`);

const baseHeaders = [`tree ${TREE}`, `author ${AUTHOR}`, `committer ${COMMITTER}`];

const view = (raw: Uint8Array) => {
  const sut = parseCommitView;
  const result = sut(raw);
  return {
    tree: result.tree,
    parents: result.parents,
    author: decode(result.author),
    committer: decode(result.committer),
    encoding: decode(result.encoding),
    message: decode(result.message),
    subject: decode(result.subject),
    body: decode(result.body),
  };
};

describe('parseCommitView', () => {
  describe('Given the Pin S fixture commit', () => {
    describe('When parsing it', () => {
      it('Then tree, parents, idents, empty encoding, subject and body are exposed', () => {
        // Arrange
        const raw = commit(
          [
            `tree ${TREE}`,
            `parent ${PARENT_A}`,
            `parent ${PARENT_B}`,
            `author ${AUTHOR}`,
            `committer ${COMMITTER}`,
          ],
          'msg subject line\n\nbody para\n\nSigned-off-by: X <x@y>\n',
        );

        // Act
        const result = view(raw);

        // Assert
        expect(result).toEqual({
          tree: TREE,
          parents: [PARENT_A, PARENT_B],
          author: AUTHOR,
          committer: COMMITTER,
          encoding: undefined,
          message: 'msg subject line\n\nbody para\n\nSigned-off-by: X <x@y>\n',
          subject: 'msg subject line\n',
          body: 'body para\n\nSigned-off-by: X <x@y>\n',
        });
      });
    });
  });

  describe('Given a commit without a body', () => {
    describe('When parsing it', () => {
      it('Then the body is empty', () => {
        // Arrange
        const raw = commit(baseHeaders, 'only subject\n');

        // Act
        const result = view(raw);

        // Assert
        expect(result.subject).toBe('only subject\n');
        expect(result.body).toBe('');
      });
    });
  });

  describe('Given a subject paragraph over several lines', () => {
    describe('When parsing it', () => {
      it('Then the subject spans the paragraph and the body starts after the blank lines', () => {
        // Arrange
        const raw = commit(baseHeaders, 'line one\nline two\n \t \n\nbody\n');

        // Act
        const result = view(raw);

        // Assert
        expect(result.subject).toBe('line one\nline two\n');
        expect(result.body).toBe('body\n');
      });
    });
  });

  describe('Given blank lines before the subject', () => {
    describe('When parsing it', () => {
      it('Then they are skipped and the message keeps them', () => {
        // Arrange
        const raw = commit(baseHeaders, '\n  \nsubject\n\nbody');

        // Act
        const result = view(raw);

        // Assert
        expect(result.message).toBe('\n  \nsubject\n\nbody');
        expect(result.subject).toBe('subject\n');
        expect(result.body).toBe('body');
      });
    });
  });

  describe('Given a message with no trailing newline on the subject', () => {
    describe('When parsing it', () => {
      it('Then the subject runs to the end of the buffer', () => {
        // Arrange
        const raw = commit(baseHeaders, 'subject');

        // Act
        const result = view(raw);

        // Assert
        expect(result.subject).toBe('subject');
        expect(result.body).toBe('');
      });
    });
  });

  describe('Given an encoding header', () => {
    describe('When parsing it', () => {
      it('Then the value is returned verbatim', () => {
        // Arrange
        const raw = commit([...baseHeaders, 'encoding ISO-8859-1'], 'café subj\n');

        // Act
        const result = view(raw);

        // Assert
        expect(result.encoding).toBe('ISO-8859-1');
      });
    });
  });

  describe('Given a gpgsig header with continuation lines containing header-like text', () => {
    describe('When parsing it', () => {
      it('Then the continuation lines are skipped', () => {
        // Arrange
        const raw = commit(
          [
            ...baseHeaders,
            'gpgsig -----BEGIN PGP SIGNATURE-----',
            ' author Fake <f@f> 1 +0000',
            ' encoding bogus',
            ' ',
            ' -----END PGP SIGNATURE-----',
          ],
          'subject\n',
        );

        // Act
        const result = view(raw);

        // Assert
        expect(result.author).toBe(AUTHOR);
        expect(result.encoding).toBeUndefined();
        expect(result.subject).toBe('subject\n');
      });
    });
  });

  describe('Given a repeated author header', () => {
    describe('When parsing it', () => {
      it('Then the last one wins, as in git', () => {
        // Arrange
        const raw = commit([...baseHeaders, 'author Later <l@l> 2 +0000'], 's\n');

        // Act
        const result = view(raw);

        // Assert
        expect(result.author).toBe('Later <l@l> 2 +0000');
      });
    });
  });

  describe('Given a buffer with no blank line', () => {
    describe('When parsing it', () => {
      it('Then the message, subject and body are empty', () => {
        // Arrange
        const raw = encode(`tree ${TREE}\nauthor ${AUTHOR}\n`);

        // Act
        const result = view(raw);

        // Assert
        expect(result.author).toBe(AUTHOR);
        expect(result.message).toBe('');
        expect(result.subject).toBe('');
        expect(result.body).toBe('');
      });
    });
  });

  describe('Given a header line without a trailing newline at the end of the buffer', () => {
    describe('When parsing it', () => {
      it('Then the header runs to the end of the buffer', () => {
        // Arrange
        const raw = encode(`author ${AUTHOR}`);

        // Act
        const result = view(raw);

        // Assert
        expect(result.author).toBe(AUTHOR);
      });
    });
  });

  describe('Given a NUL byte inside the message', () => {
    describe('When parsing it', () => {
      it('Then everything from the NUL is ignored, as git reads a C string', () => {
        // Arrange
        const raw = commit(baseHeaders, 'subject\n\nbody\0hidden\n');

        // Act
        const result = view(raw);

        // Assert
        expect(result.message).toBe('subject\n\nbody');
        expect(result.body).toBe('body');
      });
    });
  });

  describe('Given a NUL byte anywhere in the commit', () => {
    describe('When parsing it', () => {
      it('Then the raw buffer git re-encodes stops at the NUL', () => {
        // Arrange
        const raw = commit(baseHeaders, 'subject\0hidden\n');
        const sut = parseCommitView;

        // Act
        const result = sut(raw);

        // Assert
        expect(decode(result.raw)).toBe(`${baseHeaders.join('\n')}\n\nsubject`);
      });
    });
  });

  describe('Given a NUL byte inside a header', () => {
    describe('When parsing it', () => {
      it('Then the buffer ends at the NUL', () => {
        // Arrange
        const raw = encode(`author ${AUTHOR}\0\n\nsubject\n`);

        // Act
        const result = view(raw);

        // Assert
        expect(result.author).toBe(AUTHOR);
        expect(result.message).toBe('');
      });
    });
  });

  describe('Given headers that look like tree or parent but are misplaced', () => {
    describe('When parsing it', () => {
      it('Then tree must be first and parents must directly follow it', () => {
        // Arrange
        const raw = commit([`author ${AUTHOR}`, `tree ${TREE}`, `parent ${PARENT_A}`], 's\n');

        // Act
        const result = view(raw);

        // Assert
        expect(result.tree).toBeUndefined();
        expect(result.parents).toEqual([]);
      });
    });
  });

  describe('Given a parent line after a non-parent header', () => {
    describe('When parsing it', () => {
      it('Then only the contiguous parents after the tree are returned', () => {
        // Arrange
        const raw = commit(
          [`tree ${TREE}`, `parent ${PARENT_A}`, `author ${AUTHOR}`, `parent ${PARENT_B}`],
          's\n',
        );

        // Act
        const result = view(raw);

        // Assert
        expect(result.tree).toBe(TREE);
        expect(result.parents).toEqual([PARENT_A]);
      });
    });
  });

  describe('Given a header whose lines after the tree are all parents', () => {
    describe('When parsing it', () => {
      it('Then every parent line is listed', () => {
        // Arrange
        const sut = parseCommitView;

        // Act
        const result = sut(
          commit([`tree ${TREE}`, `parent ${PARENT_A}`, `parent ${PARENT_B}`], 'm'),
        );

        // Assert
        expect(result.parents).toEqual([PARENT_A, PARENT_B]);
      });
    });
  });
});
