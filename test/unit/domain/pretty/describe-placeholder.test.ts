import { describe, expect, it } from 'vitest';
import {
  type DescribeArgs,
  parseDescribePlaceholder,
} from '../../../../src/domain/pretty/describe-placeholder.js';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

const NO_ARGS: DescribeArgs = { tags: undefined, abbrev: undefined, match: [], exclude: [] };

const parse = (placeholder: string) => parseDescribePlaceholder(encode(`x${placeholder}tail`), 1);

describe('parseDescribePlaceholder', () => {
  describe('Given well-formed describe placeholders', () => {
    describe('When parsing', () => {
      it.each([
        ['(describe)', NO_ARGS],
        ['(describe:)', NO_ARGS],
        ['(describe:tags)', { ...NO_ARGS, tags: true }],
        ['(describe:tags=no)', { ...NO_ARGS, tags: false }],
        ['(describe:tags=)', { ...NO_ARGS, tags: false }],
        ['(describe:tags=TRUE)', { ...NO_ARGS, tags: true }],
        ['(describe:tags=Off)', { ...NO_ARGS, tags: false }],
        ['(describe:tags=1)', { ...NO_ARGS, tags: true }],
        ['(describe:tags=1k)', { ...NO_ARGS, tags: true }],
        ['(describe:tags=0x0)', { ...NO_ARGS, tags: false }],
        ['(describe:tags=0x1a)', { ...NO_ARGS, tags: true }],
        ['(describe:tags=-2)', { ...NO_ARGS, tags: true }],
        ['(describe:tags=00)', { ...NO_ARGS, tags: false }],
        ['(describe:tags=bogus)', NO_ARGS],
        ['(describe:tags,tags=bogus)', { ...NO_ARGS, tags: true }],
        ['(describe:tags,tags=false)', { ...NO_ARGS, tags: false }],
        ['(describe:abbrev=5)', { ...NO_ARGS, abbrev: 5 }],
        ['(describe:abbrev= 5)', { ...NO_ARGS, abbrev: 5 }],
        ['(describe:abbrev=-3)', { ...NO_ARGS, abbrev: -3 }],
        ['(describe:abbrev=+0)', { ...NO_ARGS, abbrev: 0 }],
        ['(describe:abbrev=5,)', { ...NO_ARGS, abbrev: 5 }],
        [
          '(describe:match=v*,match=x,exclude=lw)',
          { ...NO_ARGS, match: ['v*', 'x'], exclude: ['lw'] },
        ],
        ['(describe:match=é*)', { ...NO_ARGS, match: ['é*'] }],
        ['(describe:match=€*)', { ...NO_ARGS, match: ['€*'] }],
      ])('Then %s yields its arguments', (placeholder, expected) => {
        // Arrange
        const sut = parse;

        // Act
        const result = sut(placeholder);

        // Assert
        expect(result).toEqual({
          args: expected,
          length: new TextEncoder().encode(placeholder).length,
        });
      });
    });
  });

  describe('Given malformed describe placeholders', () => {
    describe('When parsing', () => {
      it.each([
        '(describeZ)',
        '(describe:foo)',
        '(describe:abbrev)',
        '(describe:abbrev=)',
        '(describe:abbrev=x)',
        '(describe:abbrev=5 )',
        '(describe:abbrev=5x)',
        '(describe:match=)',
        '(describe:exclude)',
        '(describe:tagsZ)',
        '(describe:tags',
        '(describe:match=v*',
        '(describe',
        '(decorate)',
      ])('Then %s is rejected', (placeholder) => {
        // Arrange
        const sut = (text: string) => parseDescribePlaceholder(encode(`x${text}`), 1);

        // Act
        const result = sut(placeholder);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });
});
