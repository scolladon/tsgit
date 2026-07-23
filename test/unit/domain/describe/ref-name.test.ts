import { describe, expect, it } from 'vitest';
import { describeName } from '../../../../src/domain/describe/ref-name.js';
import { RefName } from '../../../../src/domain/objects/object-id.js';

describe('describeName', () => {
  describe('Given a ref and an --all flag', () => {
    describe('When projecting the short name', () => {
      it.each([
        { raw: 'refs/tags/v2.0', all: false, expected: 'v2.0', label: 'refs/tags/ is stripped' },
        {
          raw: 'refs/heads/main',
          all: true,
          expected: 'heads/main',
          label: 'only refs/ is stripped',
        },
        {
          raw: 'refs/remotes/origin/main',
          all: true,
          expected: 'remotes/origin/main',
          label: 'it reads remotes/<remote>/<branch>',
        },
        {
          raw: 'refs/tags/v2.0',
          all: true,
          expected: 'tags/v2.0',
          label: 'it reads tags/<name> (only refs/ stripped)',
        },
        { raw: 'HEAD', all: true, expected: 'HEAD', label: 'it is returned verbatim' },
        {
          raw: 'refs/heads/main',
          all: false,
          expected: 'refs/heads/main',
          label: 'it is returned verbatim (no tags prefix to strip)',
        },
      ])('Then $label', ({ raw, all, expected }) => {
        // Arrange
        const ref = RefName.from(raw);

        // Act
        const sut = describeName(ref, all);

        // Assert
        expect(sut).toBe(expected);
      });
    });
  });
});
