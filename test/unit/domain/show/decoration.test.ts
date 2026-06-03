import { describe, expect, it } from 'vitest';

import {
  type DecorationRef,
  decorationBare,
  decorationLabels,
  decorationParen,
} from '../../../../src/domain/show/decoration.js';

const ref = (fullName: string, kind: DecorationRef['kind']): DecorationRef => ({ fullName, kind });

// The fixture from the decoration probe: branches main/zzz-branch/aaa-branch,
// tags v2.0/v1.0, remote origin/main, HEAD -> main.
const ALL: ReadonlyArray<DecorationRef> = [
  ref('refs/heads/main', 'head'),
  ref('refs/heads/zzz-branch', 'head'),
  ref('refs/heads/aaa-branch', 'head'),
  ref('refs/tags/v2.0', 'tag'),
  ref('refs/tags/v1.0', 'tag'),
  ref('refs/remotes/origin/main', 'remote'),
];

describe('Given decorationLabels', () => {
  describe('When HEAD symbolically targets a branch at the commit', () => {
    it('Then HEAD -> branch leads, then descending refs with tag: prefixes', () => {
      // Arrange + Act
      const sut = decorationLabels({ refs: ALL, headBranch: 'refs/heads/main' });

      // Assert
      expect(sut).toEqual([
        'HEAD -> main',
        'tag: v2.0',
        'tag: v1.0',
        'origin/main',
        'zzz-branch',
        'aaa-branch',
      ]);
    });
  });

  describe('When HEAD is detached at the commit', () => {
    it('Then bare HEAD leads and the branch stays in descending order', () => {
      // Arrange + Act
      const sut = decorationLabels({ refs: ALL, detachedHead: true });

      // Assert
      expect(sut).toEqual([
        'HEAD',
        'tag: v2.0',
        'tag: v1.0',
        'origin/main',
        'zzz-branch',
        'main',
        'aaa-branch',
      ]);
    });
  });

  describe('When the commit carries refs but is not HEAD', () => {
    it('Then no HEAD label is emitted', () => {
      // Arrange + Act
      const sut = decorationLabels({ refs: [ref('refs/tags/v1.0', 'tag')] });

      // Assert
      expect(sut).toEqual(['tag: v1.0']);
    });
  });

  describe('When there are no refs', () => {
    it('Then the label list is empty', () => {
      // Arrange + Act
      const sut = decorationLabels({ refs: [] });

      // Assert
      expect(sut).toEqual([]);
    });
  });
});

describe('Given the decoration renderers', () => {
  describe('When labels are present', () => {
    it('Then %D is bare and %d is parenthesised with a leading space', () => {
      // Arrange
      const labels = ['HEAD -> main', 'tag: v1.0'];

      // Act + Assert
      expect(decorationBare(labels)).toBe('HEAD -> main, tag: v1.0');
      expect(decorationParen(labels)).toBe(' (HEAD -> main, tag: v1.0)');
    });
  });

  describe('When there are no labels', () => {
    it('Then both renderers are empty', () => {
      // Arrange + Act + Assert
      expect(decorationBare([])).toBe('');
      expect(decorationParen([])).toBe('');
    });
  });
});
