import { describe, expect, it } from 'vitest';

import {
  CONFIGURABLE_MSG_IDS,
  type FsckSeverityTable,
  parseFsckSeverity,
  retypeSeverity,
} from '../../../../src/domain/fsck/index.js';

/** A severity table keyed the way the configuration reader keys it. */
const tableOf = (entries: ReadonlyArray<readonly [string, 'error' | 'warning' | 'ignore']>) =>
  new Map(entries.map(([msgId, severity]) => [msgId.toLowerCase(), severity])) as FsckSeverityTable;

describe('parseFsckSeverity', () => {
  describe('Given one of the three words the configuration accepts', () => {
    describe('When parsed', () => {
      it.each([
        { value: 'error', expected: 'error' },
        { value: 'warn', expected: 'warning' },
        { value: 'ignore', expected: 'ignore' },
      ])('Then $value names $expected', ({ value, expected }) => {
        // Arrange
        const sut = parseFsckSeverity;

        // Act
        const result = sut(value);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given a word outside that set', () => {
    describe('When parsed', () => {
      it.each([{ value: 'warning' }, { value: 'info' }, { value: 'ERROR' }, { value: '' }])(
        'Then $value names nothing',
        ({ value }) => {
          // Arrange
          const sut = parseFsckSeverity;

          // Act
          const result = sut(value);

          // Assert
          expect(result).toBeUndefined();
        },
      );
    });
  });
});

describe('retypeSeverity', () => {
  describe('Given a table that re-types the msg-id', () => {
    describe('When the base severity is resolved against it', () => {
      it('Then the configured severity wins', () => {
        // Arrange
        const sut = retypeSeverity;

        // Act
        const result = sut(tableOf([['symlinkRef', 'error']]), 'symlinkRef', 'warning');

        // Assert
        expect(result).toBe('error');
      });
    });

    describe('When the msg-id is offered in the catalogue spelling', () => {
      it('Then it still matches — the lookup folds the id before it reaches the table', () => {
        // Arrange
        const sut = retypeSeverity;

        // Act
        const result = sut(
          tableOf([['nulInCommit', 'ignore']]),
          'nulInCommit'.toUpperCase(),
          'warning',
        );

        // Assert
        expect(result).toBe('ignore');
      });
    });
  });

  describe('Given a table key that was never folded down', () => {
    describe('When the base severity is resolved against it', () => {
      it('Then it is never found — the lookup is made on the folded form alone', () => {
        // Arrange — a Map built by hand, not by the reader, which always folds.
        const sut = retypeSeverity;
        const unfolded = new Map([['symlinkRef', 'error']]) as FsckSeverityTable;

        // Act
        const result = sut(unfolded, 'symlinkRef', 'warning');

        // Assert
        expect(result).toBe('warning');
      });
    });
  });

  describe('Given a table that says nothing about the msg-id', () => {
    describe('When the base severity is resolved against it', () => {
      it('Then the base severity is kept', () => {
        // Arrange
        const sut = retypeSeverity;

        // Act
        const result = sut(tableOf([['badTree', 'ignore']]), 'symlinkRef', 'warning');

        // Assert
        expect(result).toBe('warning');
      });
    });
  });
});

/**
 * Every name `fsck.<msg-id>` accepts, spelled the way the catalogue spells it.
 * Each one was offered to `git fsck -c fsck.<name>=error` on git 2.55.0 and
 * accepted; the list also covers, without a gap, every id git's own
 * `fsck-msgids` documentation names. Wider than the set this repository emits:
 * git accepts a re-typing for checks tsgit has no counterpart for.
 */
const ACCEPTED_MSG_ID_NAMES: ReadonlyArray<string> = [
  'badDate',
  'badDateOverflow',
  'badEmail',
  'badFilemode',
  'badGpgsig',
  'badHeadTarget',
  'badHeaderContinuation',
  'badName',
  'badObjectSha1',
  'badPackedRefEntry',
  'badPackedRefHeader',
  'badParentSha1',
  'badRefContent',
  'badRefFiletype',
  'badRefName',
  'badRefOid',
  'badReferentName',
  'badReftableTableName',
  'badTagName',
  'badTimezone',
  'badTree',
  'badTreeSha1',
  'badType',
  'duplicateEntries',
  'emptyName',
  'emptyPackedRefsFile',
  'extraHeaderEntry',
  'fullPathname',
  'gitattributesBlob',
  'gitattributesLarge',
  'gitattributesLineLength',
  'gitattributesMissing',
  'gitattributesSymlink',
  'gitignoreSymlink',
  'gitmodulesBlob',
  'gitmodulesLarge',
  'gitmodulesMissing',
  'gitmodulesName',
  'gitmodulesParse',
  'gitmodulesPath',
  'gitmodulesSymlink',
  'gitmodulesUpdate',
  'gitmodulesUrl',
  'hasDot',
  'hasDotdot',
  'hasDotgit',
  'largePathname',
  'mailmapSymlink',
  'missingAuthor',
  'missingCommitter',
  'missingEmail',
  'missingNameBeforeEmail',
  'missingObject',
  'missingSpaceBeforeDate',
  'missingSpaceBeforeEmail',
  'missingTag',
  'missingTagEntry',
  'missingTaggerEntry',
  'missingTree',
  'missingType',
  'missingTypeEntry',
  'multipleAuthors',
  'nulInCommit',
  'nulInHeader',
  'nullSha1',
  'packedRefEntryNotTerminated',
  'packedRefUnsorted',
  'refMissingNewline',
  'symlinkRef',
  'symrefTargetIsNotARef',
  'trailingRefContent',
  'treeNotSorted',
  'unknownType',
  'unterminatedHeader',
  'zeroPaddedDate',
  'zeroPaddedFilemode',
];

describe('CONFIGURABLE_MSG_IDS', () => {
  describe('Given the set of msg-ids the configuration may re-type', () => {
    describe('When the set is enumerated', () => {
      it('Then it holds exactly the names git accepts, each folded down', () => {
        // Arrange
        const expected = ACCEPTED_MSG_ID_NAMES.map((name) => name.toLowerCase()).sort();

        // Act
        const result = [...CONFIGURABLE_MSG_IDS].sort();

        // Assert
        expect(result).toEqual(expected);
      });
    });

    describe('When a name no fsck check reports is looked up', () => {
      it('Then the set rejects it, so the configuration refuses on it', () => {
        // Arrange
        const absent = 'noSuchThing'.toLowerCase();

        // Act
        const result = CONFIGURABLE_MSG_IDS.has(absent);

        // Assert
        expect(result).toBe(false);
      });
    });
  });
});
