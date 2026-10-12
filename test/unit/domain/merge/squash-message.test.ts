import { describe, expect, it } from 'vitest';
import { squashMessage } from '../../../../src/domain/merge/squash-message.js';
import type { ObjectId } from '../../../../src/domain/objects/index.js';

const ident = (line: string): Uint8Array => new TextEncoder().encode(line);
const author = ident('a <a@x> 1700000000 +0130');
const ONE = '8f2f9f786f12a60642c4595a9d0dd4269d014377' as ObjectId;
const TWO = 'dfd974a2faa12ad9d530c1f3041a4b69e82f56c1' as ObjectId;

describe('squashMessage', () => {
  describe('Given two commits, the older with a multi-paragraph message', () => {
    describe('When rendered', () => {
      it("Then each is listed in git's medium format under the squash header", () => {
        // Arrange
        const sut = squashMessage;

        // Act
        const result = sut([
          { id: TWO, mergeParents: [], author, message: 'side two\n' },
          { id: ONE, mergeParents: [], author, message: 'side one\n\nbody para\n\n  indented\n' },
        ]);

        // Assert
        expect(result).toBe(
          'Squashed commit of the following:\n' +
            `\ncommit ${TWO}\nAuthor: a <a@x>\nDate:   Tue Nov 14 23:43:20 2023 +0130\n\n    side two\n` +
            `\ncommit ${ONE}\nAuthor: a <a@x>\nDate:   Tue Nov 14 23:43:20 2023 +0130\n\n    side one\n    \n    body para\n    \n      indented\n`,
        );
      });
    });
  });

  describe('Given a merge commit', () => {
    describe('When rendered', () => {
      it('Then its abbreviated parents follow the commit line', () => {
        // Arrange
        const sut = squashMessage;

        // Act
        const result = sut([
          { id: ONE, mergeParents: ['dfd974a', '235c22e'], author, message: 'inner merge\n' },
        ]);

        // Assert
        expect(result).toBe(
          `Squashed commit of the following:\n\ncommit ${ONE}\nMerge: dfd974a 235c22e\nAuthor: a <a@x>\nDate:   Tue Nov 14 23:43:20 2023 +0130\n\n    inner merge\n`,
        );
      });
    });
  });

  describe('Given a message with leading blank lines, trailing spaces and trailing blank lines', () => {
    describe('When rendered', () => {
      it('Then the leading blanks are skipped and the trailing whitespace trimmed', () => {
        // Arrange
        const sut = squashMessage;

        // Act
        const result = sut([
          { id: ONE, mergeParents: [], author, message: '\n\n  subject  \t\nbody\r\n\n\n' },
        ]);

        // Assert
        expect(result).toBe(
          `Squashed commit of the following:\n\ncommit ${ONE}\nAuthor: a <a@x>\nDate:   Tue Nov 14 23:43:20 2023 +0130\n\n      subject\n    body\n`,
        );
      });
    });
  });

  describe('Given a commit with an empty message', () => {
    describe('When rendered', () => {
      it('Then the date line closes its entry', () => {
        // Arrange
        const sut = squashMessage;

        // Act
        const result = sut([{ id: ONE, mergeParents: [], author, message: '' }]);

        // Assert
        expect(result).toBe(
          `Squashed commit of the following:\n\ncommit ${ONE}\nAuthor: a <a@x>\nDate:   Tue Nov 14 23:43:20 2023 +0130\n`,
        );
      });
    });
  });

  describe('Given no commits', () => {
    describe('When rendered', () => {
      it('Then only the header is written', () => {
        // Arrange
        const sut = squashMessage;

        // Act
        const result = sut([]);

        // Assert
        expect(result).toBe('Squashed commit of the following:\n');
      });
    });
  });

  describe('Given author lines whose date does not start with a digit', () => {
    describe('When rendered', () => {
      it('Then each date falls back to the epoch in UTC, its zone dropped', () => {
        // Arrange
        const sut = squashMessage;

        // Act
        const result = sut(
          ['-5', '+5', '0x10', '1e3'].map((date) => ({
            id: ONE,
            mergeParents: [],
            author: ident(`A <a@b> ${date} +0100`),
            message: 'm\n',
          })),
        );

        // Assert
        const epoch = `\ncommit ${ONE}\nAuthor: A <a@b>\nDate:   Thu Jan 1 00:00:00 1970 +0000\n\n    m\n`;
        expect(result).toBe(`Squashed commit of the following:\n${epoch.repeat(4)}`);
      });
    });
  });

  describe('Given an author line with a second angle-bracket pair', () => {
    describe('When rendered', () => {
      it('Then the name and mail end at the first pair and the date follows the last', () => {
        // Arrange
        const sut = squashMessage;

        // Act
        const result = sut([
          { id: ONE, mergeParents: [], author: ident('A <b> <c@d> 7 +0200'), message: 'm\n' },
        ]);

        // Assert
        expect(result).toBe(
          `Squashed commit of the following:\n\ncommit ${ONE}\nAuthor: A <b>\nDate:   Thu Jan 1 02:00:07 1970 +0200\n\n    m\n`,
        );
      });
    });
  });

  describe.each([
    ['an author line without angle brackets', ident('plain name 5 +0000')],
    ['no author line', undefined],
  ])('Given %s', (_label, missing) => {
    describe('When rendered with a body', () => {
      it('Then no author or date line is written before the body', () => {
        // Arrange
        const sut = squashMessage;

        // Act
        const result = sut([{ id: ONE, mergeParents: [], author: missing, message: 'body\n' }]);

        // Assert
        expect(result).toBe(`Squashed commit of the following:\n\ncommit ${ONE}\n\n    body\n`);
      });
    });

    describe('When rendered with an empty message', () => {
      it('Then the commit line closes its entry', () => {
        // Arrange
        const sut = squashMessage;

        // Act
        const result = sut([{ id: ONE, mergeParents: [], author: missing, message: '' }]);

        // Assert
        expect(result).toBe(`Squashed commit of the following:\n\ncommit ${ONE}\n`);
      });
    });
  });

  describe('Given a message whose single leading line is blank', () => {
    describe('When rendered', () => {
      it('Then the body starts at the line after it', () => {
        // Arrange
        const sut = squashMessage;

        // Act
        const result = sut([{ id: ONE, mergeParents: [], author, message: '\nsubject\n' }]);

        // Assert
        expect(result).toBe(
          `Squashed commit of the following:\n\ncommit ${ONE}\nAuthor: a <a@x>\nDate:   Tue Nov 14 23:43:20 2023 +0130\n\n    subject\n`,
        );
      });
    });
  });
});
