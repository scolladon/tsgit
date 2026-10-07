import { describe, expect, it, vi } from 'vitest';
import type { FlatTree } from '../../../../src/domain/diff/flat-tree.js';
import {
  applyDirectoryRenames,
  directoryRenamesOf,
  locationRelevantDirectories,
  scanMergeTrees,
} from '../../../../src/domain/merge/directory-renames.js';
import type { MergeRename } from '../../../../src/domain/merge/merge-renames.js';
import { FILE_MODE, type FilePath, type ObjectId } from '../../../../src/domain/objects/index.js';

const ID = 'a'.repeat(40) as ObjectId;
const ID_C = 'c'.repeat(40) as ObjectId;

const tree = (...paths: ReadonlyArray<string>): FlatTree => ({
  entries: new Map(paths.map((path) => [path as FilePath, { id: ID, mode: FILE_MODE.REGULAR }])),
});

const rename = (oldPath: string, newPath: string): MergeRename => ({
  oldPath: oldPath as FilePath,
  newPath: newPath as FilePath,
});

const BASE = tree('dir/a', 'dir/b', 'x');
const MOVED = tree('newdir/a', 'newdir/b', 'x');
const ADDED_IN_DIR = tree('dir/a', 'dir/b', 'dir/c', 'x');
const DIR_MOVE = [rename('dir/a', 'newdir/a'), rename('dir/b', 'newdir/b')];

const paths = (flat: FlatTree): ReadonlyArray<string> => [...flat.entries.keys()].sort();

describe('locationRelevantDirectories', () => {
  describe('Given a side that removed a directory the other side added a file directly in', () => {
    describe('When its location-relevant directories are listed', () => {
      it('Then that directory is listed', () => {
        // Arrange
        const sut = locationRelevantDirectories;

        // Act
        const result = sut(scanMergeTrees(BASE), MOVED, ADDED_IN_DIR);

        // Assert
        expect([...result]).toEqual(['dir']);
      });
    });
  });

  describe.each([
    ['the other side added nothing there', BASE],
    ['the other side added only into a new subdirectory', tree('dir/a', 'dir/b', 'dir/s/c', 'x')],
  ])('Given %s', (_label, other) => {
    describe('When its location-relevant directories are listed', () => {
      it('Then none is listed', () => {
        // Arrange
        const sut = locationRelevantDirectories;

        // Act
        const result = sut(scanMergeTrees(BASE), MOVED, other);

        // Assert
        expect([...result]).toEqual([]);
      });
    });
  });

  describe('Given a side that kept the directory the other side added into', () => {
    describe('When its location-relevant directories are listed', () => {
      it('Then none is listed', () => {
        // Arrange
        const sut = locationRelevantDirectories;

        // Act
        const result = sut(scanMergeTrees(BASE), tree('dir/a', 'x'), ADDED_IN_DIR);

        // Assert
        expect([...result]).toEqual([]);
      });
    });
  });
});

describe('directoryRenamesOf', () => {
  describe('Given every file of a removed, relevant directory renamed into one directory', () => {
    describe('When the directory renames are computed', () => {
      it('Then the directory maps to that directory', () => {
        // Arrange
        const sut = directoryRenamesOf;

        // Act
        const result = sut(BASE, MOVED, ADDED_IN_DIR, DIR_MOVE);

        // Assert
        expect([...result]).toEqual([['dir', 'newdir']]);
      });
    });
  });

  describe('Given a directory whose files split evenly between two directories', () => {
    describe('When the directory renames are computed', () => {
      it('Then no directory rename is kept', () => {
        // Arrange
        const side = tree('n1/a', 'n2/b', 'x');
        const sut = directoryRenamesOf;

        // Act
        const result = sut(BASE, side, ADDED_IN_DIR, [
          rename('dir/a', 'n1/a'),
          rename('dir/b', 'n2/b'),
        ]);

        // Assert
        expect([...result]).toEqual([]);
      });
    });
  });

  describe.each([
    ['after', [rename('dir/a', 'n1/a'), rename('dir/b', 'n2/b'), rename('dir/d', 'n2/d')]],
    ['before', [rename('dir/b', 'n2/b'), rename('dir/d', 'n2/d'), rename('dir/a', 'n1/a')]],
  ])(
    'Given a majority of the files renamed into one directory, counted %s the minority',
    (_label, renames) => {
      describe('When the directory renames are computed', () => {
        it('Then the majority destination wins', () => {
          // Arrange
          const base = tree('dir/a', 'dir/b', 'dir/d');
          const side = tree('n1/a', 'n2/b', 'n2/d');
          const other = tree('dir/a', 'dir/b', 'dir/d', 'dir/c');
          const sut = directoryRenamesOf;

          // Act
          const result = sut(base, side, other, renames);

          // Assert
          expect([...result]).toEqual([['dir', 'n2']]);
        });
      });
    },
  );

  describe('Given a nested directory renamed with its parent', () => {
    describe('When the directory renames are computed', () => {
      it('Then the parent and the nested directory both map across', () => {
        // Arrange
        const base = tree('p/q/a', 'p/q/b');
        const side = tree('r/q/a', 'r/q/b');
        const other = tree('p/q/a', 'p/q/b', 'p/c', 'p/q/c');
        const renames = [rename('p/q/a', 'r/q/a'), rename('p/q/b', 'r/q/b')];
        const sut = directoryRenamesOf;

        // Act
        const result = sut(base, side, other, renames);

        // Assert
        expect(new Map(result)).toEqual(
          new Map([
            ['p/q', 'r/q'],
            ['p', 'r'],
          ]),
        );
      });
    });
  });

  describe('Given a parent directory nobody added into above a relevant one', () => {
    describe('When the directory renames are computed', () => {
      it('Then only the relevant directory maps across', () => {
        // Arrange
        const base = tree('p/q/a', 'p/q/b', 'p/z');
        const side = tree('r/q/a', 'r/q/b', 'r/z');
        const other = tree('p/q/a', 'p/q/b', 'p/q/c', 'p/z');
        const renames = [rename('p/q/a', 'r/q/a'), rename('p/q/b', 'r/q/b')];
        const sut = directoryRenamesOf;

        // Act
        const result = sut(base, side, other, renames);

        // Assert
        expect([...result]).toEqual([['p/q', 'r/q']]);
      });
    });
  });

  describe('Given a rename whose deeper components differ', () => {
    describe('When the directory renames are computed', () => {
      it('Then only the immediate directory maps across', () => {
        // Arrange
        const base = tree('p/q/a');
        const side = tree('r/s/a');
        const other = tree('p/q/a', 'p/q/c', 'p/c');
        const sut = directoryRenamesOf;

        // Act
        const result = sut(base, side, other, [rename('p/q/a', 'r/s/a')]);

        // Assert
        expect([...result]).toEqual([['p/q', 'r/s']]);
      });
    });
  });

  describe('Given a directory renamed to the top level', () => {
    describe('When the directory renames are computed', () => {
      it('Then the directory maps to the top level', () => {
        // Arrange
        const base = tree('dir/a', 'dir/b');
        const side = tree('a', 'b');
        const other = tree('dir/a', 'dir/b', 'dir/c');
        const sut = directoryRenamesOf;

        // Act
        const result = sut(base, side, other, [rename('dir/a', 'a'), rename('dir/b', 'b')]);

        // Assert
        expect([...result]).toEqual([['dir', '']]);
      });
    });
  });
});

describe('applyDirectoryRenames', () => {
  describe('Given theirs renamed a directory ours added a file into', () => {
    describe('When the directory renames are applied', () => {
      it('Then our addition moves into the renamed directory, marked as a file location', () => {
        // Arrange
        const ours = tree('dir/a', 'dir/b', 'dir/c', 'x');
        const sut = applyDirectoryRenames;

        // Act
        const result = sut(BASE, ours, MOVED, {
          ours: [],
          theirs: DIR_MOVE,
          directoryRenames: 'conflict',
        });

        // Assert
        expect(paths(result.ours)).toEqual(['dir/a', 'dir/b', 'newdir/c', 'x']);
        expect(paths(result.theirs)).toEqual(paths(MOVED));
        expect([...result.fileLocations]).toEqual(['newdir/c']);
        expect([...result.vacated]).toEqual(['dir/c']);
      });
    });
  });

  describe('Given ours renamed a directory theirs added a file into, applied outright', () => {
    describe('When the directory renames are applied', () => {
      it('Then their addition moves with no file-location mark', () => {
        // Arrange
        const theirs = tree('dir/a', 'dir/b', 'dir/c', 'x');
        const sut = applyDirectoryRenames;

        // Act
        const result = sut(BASE, MOVED, theirs, {
          ours: DIR_MOVE,
          theirs: [],
          directoryRenames: 'apply',
        });

        // Assert
        expect(paths(result.theirs)).toEqual(['dir/a', 'dir/b', 'newdir/c', 'x']);
        expect([...result.fileLocations]).toEqual([]);
      });
    });
  });

  describe('Given ours renamed a file into a directory theirs renamed', () => {
    describe('When the directory renames are applied', () => {
      it('Then the rename follows the directory and its target moves', () => {
        // Arrange
        const ours = tree('dir/a', 'dir/b', 'dir/x');
        const theirs = tree('newdir/a', 'newdir/b', 'x');
        const renames = {
          ours: [rename('x', 'dir/x')],
          theirs: DIR_MOVE,
          directoryRenames: 'apply',
        } as const;
        const sut = applyDirectoryRenames;

        // Act
        const result = sut(BASE, ours, theirs, renames);

        // Assert
        expect(paths(result.ours)).toEqual(['dir/a', 'dir/b', 'newdir/x']);
        expect(result.renames.ours).toEqual([rename('x', 'newdir/x')]);
        expect(result.renames.theirs).toBe(DIR_MOVE);
      });
    });
  });

  describe.each([
    [
      'directory renames are off',
      { ours: [], theirs: DIR_MOVE, directoryRenames: 'none' } as const,
    ],
    ['no side renamed a file', { ours: [], theirs: [] }],
  ])('Given %s', (_label, renames) => {
    describe('When the directory renames are applied', () => {
      it('Then nothing moves', () => {
        // Arrange
        const ours = tree('o/a', 'dir/b', 'dir/c', 'x');
        const sut = applyDirectoryRenames;

        // Act
        const result = sut(BASE, ours, MOVED, renames);

        // Assert
        expect(result.ours).toBe(ours);
        expect(result.fileLocations.size).toBe(0);
      });
    });
  });

  describe('Given the renamed directory itself renamed by the side adding into it', () => {
    describe('When the directory renames are applied', () => {
      it('Then the addition stays put', () => {
        // Arrange
        const base = tree('dir/a', 'dir/b', 'newdir/k', 'newdir/l');
        const ours = tree('dir/a', 'dir/b', 'dir/c', 'other/k', 'other/l');
        const theirs = tree('newdir/a', 'newdir/b', 'newdir/k', 'newdir/l');
        const renames = {
          ours: [rename('newdir/k', 'other/k'), rename('newdir/l', 'other/l')],
          theirs: DIR_MOVE,
          directoryRenames: 'apply',
        } as const;
        const sut = applyDirectoryRenames;

        // Act
        const result = sut(base, ours, theirs, renames);

        // Assert
        expect(paths(result.ours)).toContain('dir/c');
      });
    });
  });

  describe('Given two additions the directory rename would put on one path', () => {
    describe('When the directory renames are applied', () => {
      it('Then neither moves', () => {
        // Arrange
        const base = tree('dir/a', 'dir/b', 'd2/a', 'd2/b');
        const ours = tree('dir/a', 'dir/b', 'd2/a', 'd2/b', 'dir/c', 'd2/c');
        const theirs = tree('n/a', 'n/b', 'n/a2', 'n/b2');
        const renames = {
          ours: [],
          theirs: [
            ...DIR_MOVE.map((r) => rename(r.oldPath, `n/${r.oldPath.slice(4)}`)),
            rename('d2/a', 'n/a2'),
            rename('d2/b', 'n/b2'),
          ],
          directoryRenames: 'apply',
        } as const;
        const sut = applyDirectoryRenames;

        // Act
        const result = sut(base, ours, theirs, renames);

        // Assert
        expect(paths(result.ours)).toEqual(paths(ours));
      });
    });
  });

  describe('Given a path in the way of the moved addition', () => {
    describe('When the directory renames are applied', () => {
      it('Then the addition stays put', () => {
        // Arrange
        const base = tree('dir/a', 'dir/b', 'newdir/c');
        const ours = tree('dir/a', 'dir/b', 'dir/c', 'newdir/c');
        const theirs = tree('newdir/a', 'newdir/b', 'newdir/c');
        const sut = applyDirectoryRenames;

        // Act
        const result = sut(base, ours, theirs, {
          ours: [],
          theirs: DIR_MOVE,
          directoryRenames: 'apply',
        });

        // Assert
        expect(paths(result.ours)).toContain('dir/c');
      });
    });
  });

  describe('Given an addition the other side also added at its moved path', () => {
    describe('When the directory renames are applied', () => {
      it('Then it moves onto that path for an add/add', () => {
        // Arrange
        const ours = tree('dir/a', 'dir/b', 'dir/c', 'x');
        const theirs: FlatTree = {
          entries: new Map([
            ...MOVED.entries,
            ['newdir/c' as FilePath, { id: ID_C, mode: FILE_MODE.REGULAR }],
          ]),
        };
        const sut = applyDirectoryRenames;

        // Act
        const result = sut(BASE, ours, theirs, {
          ours: [],
          theirs: DIR_MOVE,
          directoryRenames: 'apply',
        });

        // Assert
        expect(paths(result.ours)).toContain('newdir/c');
        expect(result.sidePaths.get('newdir/c' as FilePath)).toEqual({
          base: 'newdir/c',
          ours: 'dir/c',
          theirs: 'newdir/c',
        });
      });
    });
  });

  describe('Given theirs moved a directory to the top level', () => {
    describe('When the directory renames are applied', () => {
      it('Then our addition moves to the top level', () => {
        // Arrange
        const base = tree('dir/a', 'dir/b');
        const ours = tree('dir/a', 'dir/b', 'dir/c');
        const theirs = tree('a', 'b');
        const renames = [rename('dir/a', 'a'), rename('dir/b', 'b')];
        const sut = applyDirectoryRenames;

        // Act
        const result = sut(base, ours, theirs, {
          ours: [],
          theirs: renames,
          directoryRenames: 'apply',
        });

        // Assert
        expect(paths(result.ours)).toEqual(['c', 'dir/a', 'dir/b']);
      });
    });
  });

  describe('Given no base tree', () => {
    describe('When the directory renames are applied', () => {
      it('Then nothing moves', () => {
        // Arrange
        const ours = tree('dir/c');
        const sut = applyDirectoryRenames;

        // Act
        const result = sut(undefined, ours, MOVED, {
          ours: [],
          theirs: DIR_MOVE,
          directoryRenames: 'apply',
        });

        // Assert
        expect(result.ours).toBe(ours);
      });
    });
  });
});

describe('applyDirectoryRenames cleanliness', () => {
  const SPLIT = tree('n1/a', 'n2/b', 'x');
  const SPLIT_RENAMES = [rename('dir/a', 'n1/a'), rename('dir/b', 'n2/b')];
  const COLLIDING_BASE = tree('dir/a', 'dir/b', 'd2/a', 'd2/b');
  const COLLIDING_RENAMES = [
    rename('dir/a', 'n/a'),
    rename('dir/b', 'n/b'),
    rename('d2/a', 'n/a2'),
    rename('d2/b', 'n/b2'),
  ];
  describe.each([
    {
      label: 'a directory theirs split evenly that ours added into',
      input: [BASE, ADDED_IN_DIR, SPLIT, { ours: [], theirs: SPLIT_RENAMES }],
      clean: false,
    },
    {
      label: 'a directory ours split evenly that theirs added into',
      input: [BASE, SPLIT, ADDED_IN_DIR, { ours: SPLIT_RENAMES, theirs: [] }],
      clean: false,
    },
    {
      label: 'a directory split evenly that nobody added into',
      input: [BASE, BASE, SPLIT, { ours: [], theirs: SPLIT_RENAMES }],
      clean: true,
    },
    {
      label: 'two additions a directory rename maps onto one path',
      input: [
        COLLIDING_BASE,
        tree('dir/a', 'dir/b', 'd2/a', 'd2/b', 'dir/c', 'd2/c'),
        tree('n/a', 'n/b', 'n/a2', 'n/b2'),
        { ours: [], theirs: COLLIDING_RENAMES },
      ],
      clean: false,
    },
    {
      label: 'an addition a directory rename moves onto a path ours holds',
      input: [
        BASE,
        tree('dir/a', 'dir/b', 'dir/c', 'newdir/c', 'x'),
        MOVED,
        { ours: [], theirs: DIR_MOVE },
      ],
      clean: false,
    },
    {
      label: 'an addition a directory rename moves to a free path',
      input: [BASE, ADDED_IN_DIR, MOVED, { ours: [], theirs: DIR_MOVE }],
      clean: true,
    },
    {
      label: 'a directory rename into a directory the adding side renamed again',
      input: [
        tree('dir/a', 'dir/b', 'newdir/k', 'newdir/l'),
        tree('dir/a', 'dir/b', 'dir/c', 'other/k', 'other/l'),
        tree('newdir/a', 'newdir/b', 'newdir/k', 'newdir/l'),
        { ours: [rename('newdir/k', 'other/k'), rename('newdir/l', 'other/l')], theirs: DIR_MOVE },
      ],
      clean: true,
    },
  ] as const)('Given $label', ({ input: [base, ours, theirs, renames], clean }) => {
    describe('When the directory renames are applied', () => {
      it(`Then the result is ${clean ? 'clean' : 'unclean'}`, () => {
        // Arrange
        const sut = applyDirectoryRenames;

        // Act
        const result = sut(base, ours, theirs, { ...renames, directoryRenames: 'apply' });

        // Assert
        expect(result.clean).toBe(clean);
      });
    });
  });

  describe('Given an evenly split directory with directory renames off', () => {
    describe('When the directory renames are applied', () => {
      it('Then the result is clean', () => {
        // Arrange
        const sut = applyDirectoryRenames;

        // Act
        const result = sut(BASE, ADDED_IN_DIR, SPLIT, {
          ours: [],
          theirs: SPLIT_RENAMES,
          directoryRenames: 'none',
        });

        // Assert
        expect(result.clean).toBe(true);
      });
    });
  });
});

describe('applyDirectoryRenames scanning', () => {
  const scanCounters = (...trees: ReadonlyArray<FlatTree>) =>
    trees.map((flat) => vi.spyOn(flat.entries as Map<FilePath, unknown>, 'keys'));

  describe('Given neither side renamed a file', () => {
    describe('When the directory renames are applied', () => {
      it('Then no tree is scanned and both sides come back unchanged', () => {
        // Arrange
        const [base, ours, theirs] = [tree('dir/a', 'x'), tree('dir/a', 'dir/c'), tree('y')];
        const counters = scanCounters(base, ours, theirs);
        const renames = { ours: [], theirs: [], directoryRenames: 'apply' } as const;
        const sut = applyDirectoryRenames;

        // Act
        const result = sut(base, ours, theirs, renames);

        // Assert
        expect(counters.map((counter) => counter.mock.calls.length)).toEqual([0, 0, 0]);
        expect(result).toEqual({
          ours,
          theirs,
          renames,
          fileLocations: new Set(),
          vacated: new Set(),
          sidePaths: new Map(),
          clean: true,
        });
      });
    });
  });

  describe('Given theirs renamed a directory ours added a file into', () => {
    describe('When the directory renames are applied', () => {
      it('Then each tree is scanned for its directories and additions once', () => {
        // Arrange
        const [base, ours, theirs] = [tree('dir/a', 'dir/b', 'x'), ADDED_IN_DIR, MOVED];
        const counters = scanCounters(base, ours, theirs);
        const renames = { ours: [], theirs: DIR_MOVE, directoryRenames: 'apply' } as const;
        const sut = applyDirectoryRenames;

        // Act
        const result = sut(base, ours, theirs, renames);

        // Assert
        expect(counters.map((counter) => counter.mock.calls.length)).toEqual([1, 2, 2]);
        expect(paths(result.ours)).toEqual(['dir/a', 'dir/b', 'newdir/c', 'x']);
      });
    });
  });
});
