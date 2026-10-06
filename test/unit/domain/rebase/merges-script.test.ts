import { describe, expect, it } from 'vitest';
import type { ObjectId } from '../../../../src/domain/objects/index.js';
import {
  type MergesScriptInput,
  makeScriptWithMerges,
  type ScriptCommit,
} from '../../../../src/domain/rebase/index.js';

const id = (name: string): ObjectId => name as ObjectId;

const commit = (name: string, parents: ReadonlyArray<string>, subject = name): ScriptCommit => ({
  id: id(name),
  parents: parents.map(id),
  subject,
  skipped: false,
});

const input = (overrides: Partial<MergesScriptInput>): MergesScriptInput => ({
  commits: [],
  ontoBase: id('base'),
  branchNames: new Map(),
  abbreviations: new Map(),
  outsideSubjects: new Map(),
  rebaseCousins: false,
  ...overrides,
});

// base ── c1 ── c2 ── M ── c3, with side s1 forked from c1 and merged by M.
const forked = [
  commit('c1', ['base']),
  commit('s1', ['c1']),
  commit('c2', ['c1']),
  commit('M', ['c2', 's1'], "Merge branch 'side' into topic"),
  commit('c3', ['M']),
];

// main: base ── m1; side s1 forks from m1, topic c1 from base, M merges side.
const cousin = [
  commit('c1', ['base']),
  commit('s1', ['m1']),
  commit('M', ['c1', 's1'], "Merge branch 'side' into topic"),
];

const mergeOf = (subject: string, second = 's1') => [
  commit('c1', ['base']),
  commit(second, ['base']),
  commit('M', ['c1', second], subject),
];

const mergeLabelOf = (scriptInput: MergesScriptInput): ReadonlyArray<string> | undefined => {
  const merges = makeScriptWithMerges(scriptInput).filter((line) => line.action === 'merge');
  const merge = merges[merges.length - 1];
  return merge?.action === 'merge' ? merge.labels : undefined;
};

describe('makeScriptWithMerges', () => {
  describe('Given a branch that forked a side branch and merged it back', () => {
    describe('When the todo is generated', () => {
      it('Then it labels the branch point and the tip, and resets between blocks', () => {
        // Arrange
        const sut = makeScriptWithMerges;

        // Act
        const result = sut(input({ commits: forked }));

        // Assert
        expect(result).toEqual([
          { action: 'label', label: 'onto' },
          { action: 'reset', label: 'onto', branch: 'side' },
          { action: 'pick', oid: 'c1', subject: 'c1' },
          { action: 'label', label: 'branch-point' },
          { action: 'pick', oid: 's1', subject: 's1' },
          { action: 'label', label: 'side' },
          { action: 'reset', label: 'branch-point', subject: 'c1' },
          { action: 'pick', oid: 'c2', subject: 'c2' },
          {
            action: 'merge',
            oid: 'M',
            labels: ['side'],
            subject: "Merge branch 'side' into topic",
          },
          { action: 'pick', oid: 'c3', subject: 'c3' },
        ]);
      });
    });

    describe('When a commit is already upstream', () => {
      it('Then its pick is left out while its label stays', () => {
        // Arrange
        const sut = makeScriptWithMerges;
        const commits = forked.map((c) => (c.id === 's1' ? { ...c, skipped: true } : c));

        // Act
        const result = sut(input({ commits }));

        // Assert
        expect(result.slice(3, 5)).toEqual([
          { action: 'label', label: 'branch-point' },
          { action: 'label', label: 'side' },
        ]);
      });
    });
  });

  describe('Given a merged side branch rooted on a commit outside the range', () => {
    const abbreviations = new Map([[id('base'), 'b78aa0f']]);
    const outsideSubjects = new Map([[id('base'), 'base']]);

    describe('When cousins are not rebased', () => {
      it("Then the cousin's block resets to the commit's abbreviation", () => {
        // Arrange
        const sut = makeScriptWithMerges;

        // Act
        const result = sut(
          input({ commits: cousin, ontoBase: id('m1'), abbreviations, outsideSubjects }),
        );

        // Assert
        expect(result.slice(1, 6)).toEqual([
          { action: 'reset', label: 'onto', branch: 'side' },
          { action: 'pick', oid: 's1', subject: 's1' },
          { action: 'label', label: 'side' },
          { action: 'reset', label: 'b78aa0f', subject: 'base' },
          { action: 'pick', oid: 'c1', subject: 'c1' },
        ]);
      });
    });

    describe('When cousins are rebased', () => {
      it('Then every block resets onto the new base', () => {
        // Arrange
        const sut = makeScriptWithMerges;

        // Act
        const result = sut(
          input({
            commits: cousin,
            ontoBase: id('m1'),
            abbreviations,
            outsideSubjects,
            rebaseCousins: true,
          }),
        );

        // Assert
        expect(result[4]).toEqual({ action: 'reset', label: 'onto' });
      });
    });
  });

  describe('Given the label a merge gives its side branch', () => {
    describe('When the merged tip carries a branch name', () => {
      it('Then the branch name labels it', () => {
        // Arrange
        const branchNames = new Map([[id('s1'), 'feature']]);

        // Act
        const result = mergeLabelOf(
          input({ commits: mergeOf("Merge branch 'side'"), branchNames }),
        );

        // Assert
        expect(result).toEqual(['feature']);
      });
    });

    describe('When the subject names no branch', () => {
      it.each([
        { subject: "Merge branch 'feature/x_y'", expected: 'feature-x-y' },
        { subject: 'Merge pull request #12 from org/topic', expected: 'org-topic' },
        { subject: 'Some merge!', expected: 'Some-merge-' },
        { subject: 'Merge café', expected: 'Merge-café' },
        { subject: '!!!', expected: 'rev-s1abbr' },
        { subject: 'onto', expected: 'onto-2' },
        { subject: 'g'.repeat(40), expected: 'g'.repeat(40) },
        { subject: 'f'.repeat(40), expected: `${'f'.repeat(40)}-2` },
        { subject: 'x'.repeat(300), expected: 'x'.repeat(233) },
        { subject: `${'x'.repeat(232)}€`, expected: 'x'.repeat(232) },
      ])('Then "$subject" sanitizes to "$expected"', ({ subject, expected }) => {
        // Arrange
        const tip = '1'.repeat(40);
        const abbreviations = new Map([[id(tip), 's1abbr']]);

        // Act
        const result = mergeLabelOf(input({ commits: mergeOf(subject, tip), abbreviations }));

        // Assert
        expect(result).toEqual([expected]);
      });
    });

    describe('When the suffixed label is taken as well', () => {
      it('Then the suffix counts on past it as git does', () => {
        // Arrange
        const commits = [
          ...mergeOf('onto'),
          commit('s2', ['base']),
          commit('M2', ['M', 's2'], 'onto'),
        ];

        // Act
        const result = mergeLabelOf(input({ commits }));

        // Assert
        expect(result).toEqual(['onto-3']);
      });
    });

    describe('When the merged parent is outside the range', () => {
      it('Then its abbreviation labels it, lengthened past a clashing label', () => {
        // Arrange
        const commits = [
          ...mergeOf("Merge branch 'abcdef0'"),
          commit('N', ['M', 'abcdef012'], 'Merge upstream'),
        ];
        const abbreviations = new Map([[id('abcdef012'), 'abcdef0']]);

        // Act
        const result = mergeLabelOf(input({ commits, abbreviations }));

        // Assert
        expect(result).toEqual(['abcdef01']);
      });
    });

    describe('When every abbreviation of the merged parent is already a label', () => {
      it('Then its full oid labels it', () => {
        // Arrange
        const commits = [
          ...mergeOf("Merge branch 'abcdef0'"),
          commit('o1', ['M']),
          commit('o2', ['M']),
          commit('N', ['o1', 'o2'], "Merge branch 'abcdef01'"),
          commit('P', ['N', 'abcdef012'], 'Merge upstream'),
        ];
        const abbreviations = new Map([[id('abcdef012'), 'abcdef0']]);

        // Act
        const result = mergeLabelOf(input({ commits, abbreviations }));

        // Assert
        expect(result).toEqual(['abcdef012']);
      });
    });
  });

  describe('Given a range reaching a root commit', () => {
    describe.each([
      { rebaseCousins: false, expected: '[new root]' },
      { rebaseCousins: true, expected: 'onto' },
    ])('When cousins rebase is $rebaseCousins', ({ rebaseCousins, expected }) => {
      it(`Then the root's block resets to ${expected}`, () => {
        // Arrange
        const sut = makeScriptWithMerges;

        // Act
        const result = sut(
          input({ commits: [commit('r1', [])], ontoBase: undefined, rebaseCousins }),
        );

        // Assert
        expect(result[1]).toEqual({ action: 'reset', label: expected });
      });
    });
  });

  describe('Given label bookkeeping corners', () => {
    describe('When nothing is walked', () => {
      it('Then the todo only labels onto', () => {
        // Arrange
        const sut = makeScriptWithMerges;

        // Act
        const result = sut(input({}));

        // Assert
        expect(result).toEqual([{ action: 'label', label: 'onto' }]);
      });
    });

    describe('When a cousin forks from a commit nothing describes', () => {
      it('Then its seven-character prefix labels it, with an empty oneline', () => {
        // Arrange
        const sut = makeScriptWithMerges;

        // Act
        const result = sut(input({ commits: cousin, ontoBase: id('m1') }));

        // Assert
        expect(result[4]).toEqual({ action: 'reset', label: 'base', subject: '' });
      });
    });

    describe('When a merged tip also branches', () => {
      it('Then it keeps its tip label instead of becoming a branch point', () => {
        // Arrange
        const sut = makeScriptWithMerges;
        const commits = [
          commit('c1', ['base']),
          commit('s1', ['base']),
          commit('M', ['c1', 's1'], "Merge branch 'side'"),
          commit('s2', ['s1']),
          commit('N', ['M', 's2'], "Merge branch 'more'"),
        ];

        // Act
        const result = sut(input({ commits }));

        // Assert
        expect(result.filter((line) => line.action === 'label')).toEqual([
          { action: 'label', label: 'onto' },
          { action: 'label', label: 'side' },
          { action: 'label', label: 'more' },
        ]);
      });
    });

    describe('When a merged tip was already shown in an earlier block', () => {
      it('Then it opens no block of its own', () => {
        // Arrange
        const sut = makeScriptWithMerges;
        const commits = [
          commit('c1', ['base']),
          commit('s1', ['base']),
          commit('s2', ['s1']),
          commit('M1', ['c1', 's2'], "Merge branch 'a'"),
          commit('M2', ['M1', 's1'], "Merge branch 'b'"),
        ];

        // Act
        const result = sut(input({ commits }));

        // Assert
        expect(result.filter((line) => line.action === 'reset')).toHaveLength(2);
      });
    });
  });
});
