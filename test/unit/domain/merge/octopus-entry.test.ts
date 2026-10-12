import { describe, expect, it } from 'vitest';
import {
  type OctopusSide,
  resolveOctopusEntry,
} from '../../../../src/domain/merge/octopus-entry.js';
import { FILE_MODE, type FileMode, type ObjectId } from '../../../../src/domain/objects/index.js';

const side = (seed: string, mode: FileMode = FILE_MODE.REGULAR): OctopusSide => ({
  id: seed.repeat(40) as ObjectId,
  mode,
});

const O = side('0');
const A = side('a');
const B = side('b');
const O_EXEC = side('0', FILE_MODE.EXECUTABLE);

describe('resolveOctopusEntry', () => {
  describe('Given a path read-tree --aggressive resolves trivially', () => {
    describe('When the entry is resolved', () => {
      it.each([
        ['ours unchanged, theirs changed: theirs', [O], O, A, { kind: 'take', side: A }],
        ['theirs unchanged, ours changed: ours', [O], A, O, { kind: 'take', side: A }],
        ['both changed the same way: ours', [O], A, A, { kind: 'take', side: A }],
        ['added identically on both sides: ours', [undefined], A, A, { kind: 'take', side: A }],
        ['added on theirs only: theirs', [undefined], undefined, A, { kind: 'take', side: A }],
        ['added on ours only: ours', [undefined], A, undefined, { kind: 'take', side: A }],
        ['deleted on both sides: dropped', [O], undefined, undefined, { kind: 'drop' }],
        ['deleted by ours, unchanged by theirs: dropped', [O], undefined, O, { kind: 'drop' }],
        ['deleted by theirs, unchanged by ours: dropped', [O], O, undefined, { kind: 'drop' }],
        ['ours matching any one of several bases: theirs', [B, O], O, A, { kind: 'take', side: A }],
        ['theirs matching any one of several bases: ours', [B, O], A, O, { kind: 'take', side: A }],
      ] as const)('Then %s', (_label, bases, head, remote, expected) => {
        // Arrange
        const sut = resolveOctopusEntry;

        // Act
        const result = sut(bases, head, remote);

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });

  describe('Given a path left for git-merge-one-file', () => {
    describe('When the entry is resolved', () => {
      it.each([
        [
          'both changed differently: a content merge over the base',
          [O],
          A,
          B,
          { kind: 'content', base: O, head: A, remote: B },
        ],
        [
          'added differently on both sides: a content merge with no base',
          [undefined],
          A,
          B,
          { kind: 'content', base: undefined, head: A, remote: B },
        ],
        [
          'several bases, sides matching distinct ones: a content merge with no base',
          [A, B],
          A,
          B,
          { kind: 'content', base: undefined, head: A, remote: B },
        ],
        [
          'several bases matching neither side: the first present base',
          [undefined, O, B],
          A,
          side('c'),
          { kind: 'content', base: O, head: A, remote: side('c') },
        ],
        [
          'modified by ours, deleted by theirs: unmerged',
          [O],
          A,
          undefined,
          { kind: 'unmerged', base: O, head: A, remote: undefined },
        ],
        [
          'deleted by ours, modified by theirs: unmerged',
          [O],
          undefined,
          A,
          { kind: 'unmerged', base: O, head: undefined, remote: A },
        ],
        [
          'deleted by ours, mode changed by theirs: unmerged',
          [O],
          undefined,
          O_EXEC,
          { kind: 'unmerged', base: O, head: undefined, remote: O_EXEC },
        ],
        [
          'mode changed by ours, deleted by theirs: unmerged',
          [O],
          O_EXEC,
          undefined,
          { kind: 'unmerged', base: O, head: O_EXEC, remote: undefined },
        ],
      ] as const)('Then %s', (_label, bases, head, remote, expected) => {
        // Arrange
        const sut = resolveOctopusEntry;

        // Act
        const result = sut(bases, head, remote);

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });
});
