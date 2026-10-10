import { describe, expect, it } from 'vitest';
import {
  type Decoration,
  formatDecorations,
  parseDecoratePlaceholder,
} from '../../../../src/domain/pretty/decorations.js';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);

const TAG: Decoration = { kind: 'tag', name: 'refs/tags/lt2' };
const STASH: Decoration = { kind: 'stash', name: 'refs/stash' };
const REMOTE: Decoration = { kind: 'remote', name: 'refs/remotes/o/main' };
const SIDE: Decoration = { kind: 'branch', name: 'refs/heads/side' };
const MAIN: Decoration = { kind: 'branch', name: 'refs/heads/main' };
const CUSTOM: Decoration = { kind: 'other', name: 'refs/custom/x' };

const attachedHead: Decoration = { kind: 'head', name: 'HEAD', attachedTo: 'refs/heads/main' };
const detachedHead: Decoration = { kind: 'head', name: 'HEAD' };
const REST = [TAG, STASH, REMOTE, SIDE, MAIN, CUSTOM];

describe('formatDecorations', () => {
  describe('Given HEAD attached to a decorated branch', () => {
    describe('When rendering with the defaults', () => {
      it('Then the branch folds into HEAD and the rest keep their order', () => {
        // Arrange
        const sut = formatDecorations;

        // Act
        const result = sut([attachedHead, ...REST], {});

        // Assert
        expect(decode(result)).toBe(
          ' (HEAD -> main, tag: lt2, refs/stash, o/main, side, refs/custom/x)',
        );
      });
    });
  });

  describe('Given a detached HEAD', () => {
    describe('When rendering with the defaults', () => {
      it('Then HEAD stands alone and every branch keeps its place', () => {
        // Arrange
        const sut = formatDecorations;

        // Act
        const result = sut([detachedHead, ...REST], {});

        // Assert
        expect(decode(result)).toBe(
          ' (HEAD, tag: lt2, refs/stash, o/main, side, main, refs/custom/x)',
        );
      });
    });
  });

  describe('Given HEAD attached to a branch absent from the list', () => {
    describe('When rendering with the defaults', () => {
      it('Then HEAD stands alone', () => {
        // Arrange
        const sut = formatDecorations;

        // Act
        const result = sut([attachedHead, SIDE], {});

        // Assert
        expect(decode(result)).toBe(' (HEAD, side)');
      });
    });
  });

  describe('Given no decoration', () => {
    describe('When rendering with the defaults', () => {
      it('Then nothing is emitted, not even the affixes', () => {
        // Arrange
        const sut = formatDecorations;

        // Act
        const result = sut([], {});

        // Assert
        expect(decode(result)).toBe('');
      });
    });
  });

  describe('Given custom options', () => {
    describe('When prefix and suffix are empty', () => {
      it('Then only the names and separators remain', () => {
        // Arrange
        const sut = formatDecorations;

        // Act
        const result = sut([attachedHead, TAG, MAIN], { prefix: encode(''), suffix: encode('') });

        // Assert
        expect(decode(result)).toBe('HEAD -> main, tag: lt2');
      });
    });

    describe('When every option is replaced', () => {
      it('Then each replacement lands where git puts it', () => {
        // Arrange
        const sut = formatDecorations;
        const options = {
          prefix: encode('['),
          suffix: encode(']'),
          separator: encode('|'),
          pointer: encode('=>'),
          tag: encode('T:'),
        };

        // Act
        const result = sut([attachedHead, TAG, MAIN], options);

        // Assert
        expect(decode(result)).toBe('[HEAD=>main|T:lt2]');
      });
    });

    describe('When the tag marker is empty', () => {
      it('Then tags render as bare names', () => {
        // Arrange
        const sut = formatDecorations;

        // Act
        const result = sut([TAG], { tag: encode('') });

        // Assert
        expect(decode(result)).toBe(' (lt2)');
      });
    });
  });
});

const text = (bytes: Uint8Array | undefined): string | undefined =>
  bytes && new TextDecoder('latin1').decode(bytes);

describe('parseDecoratePlaceholder', () => {
  describe('Given a bare (decorate) placeholder', () => {
    describe('When parsing at the open parenthesis', () => {
      it('Then no option is set and the whole placeholder is consumed', () => {
        // Arrange
        const sut = parseDecoratePlaceholder;

        // Act
        const result = sut(encode('(decorate)rest'), 0);

        // Assert
        expect(result).toEqual({ options: {}, length: 10 });
      });
    });
  });

  describe('Given option lists', () => {
    describe('When every option is given a value', () => {
      it('Then each value is read up to the next comma or parenthesis', () => {
        // Arrange
        const sut = parseDecoratePlaceholder;
        const fmt = encode('(decorate:prefix=[,suffix=],separator=;,pointer=>,tag=T)x');

        // Act
        const result = sut(fmt, 0);

        // Assert
        expect(result?.length).toBe(fmt.length - 1);
        expect(text(result?.options.prefix)).toBe('[');
        expect(text(result?.options.suffix)).toBe(']');
        expect(text(result?.options.separator)).toBe(';');
        expect(text(result?.options.pointer)).toBe('>');
        expect(text(result?.options.tag)).toBe('T');
      });
    });

    describe('When a value holds %n, %x and %% escapes', () => {
      it('Then they are expanded and other percent sequences stay literal', () => {
        // Arrange
        const sut = parseDecoratePlaceholder;

        // Act
        const result = sut(encode('(decorate:separator=%n%x2c%%%q%xZZ)'), 0);

        // Assert
        expect(text(result?.options.separator)).toBe('\n,%%q%xZZ');
      });
    });

    describe('When an option has no value', () => {
      it('Then it is the empty string', () => {
        // Arrange
        const sut = parseDecoratePlaceholder;

        // Act
        const result = sut(encode('(decorate:prefix,suffix)'), 0);

        // Assert
        expect(text(result?.options.prefix)).toBe('');
        expect(text(result?.options.suffix)).toBe('');
      });
    });

    describe('When an option is repeated', () => {
      it('Then the last value wins', () => {
        // Arrange
        const sut = parseDecoratePlaceholder;

        // Act
        const result = sut(encode('(decorate:tag=a,tag=b)'), 0);

        // Assert
        expect(text(result?.options.tag)).toBe('b');
      });
    });

    describe('When the list ends with a comma', () => {
      it('Then the placeholder still parses', () => {
        // Arrange
        const sut = parseDecoratePlaceholder;

        // Act
        const result = sut(encode('(decorate:tag=a,)'), 0);

        // Assert
        expect(text(result?.options.tag)).toBe('a');
        expect(result?.length).toBe(17);
      });
    });

    describe('When the placeholder starts after other bytes', () => {
      it('Then the length counts from the open parenthesis', () => {
        // Arrange
        const sut = parseDecoratePlaceholder;

        // Act
        const result = sut(encode('xx(decorate)'), 2);

        // Assert
        expect(result?.length).toBe(10);
      });
    });
  });

  describe('Given placeholders git does not accept', () => {
    describe('When parsing at the open parenthesis', () => {
      it.each([
        '(decorate',
        '(decorate:',
        '(decorate:prefix=x',
        '(decorate:bogus)',
        '(decorate:prefixed=x)',
        '(decorate:prefixsuffix=x)',
        '(decorate:prefix=x,bogus)',
        '(decorated)',
        '(describe)',
        '(decorate:tag=a b',
      ])('Then %s is declined', (fmt) => {
        // Arrange
        const sut = parseDecoratePlaceholder;

        // Act
        const result = sut(encode(fmt), 0);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });
});
