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

    describe('When the msg-id is offered in a different case', () => {
      it('Then it still matches — the table is keyed on the lower-cased id', () => {
        // Arrange
        const sut = retypeSeverity;

        // Act
        const result = sut(tableOf([['nulInCommit', 'ignore']]), 'nulInCommit', 'warning');

        // Assert
        expect(result).toBe('ignore');
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

describe('CONFIGURABLE_MSG_IDS', () => {
  describe('Given the set of msg-ids the configuration may re-type', () => {
    describe('When a name is looked up', () => {
      it('Then it holds ids beyond this catalogue and rejects names no check reports', () => {
        // Arrange
        const sut = CONFIGURABLE_MSG_IDS;

        // Act & Assert — an id this repository emits, one it never emits but
        // git still accepts, and a name git refuses outright.
        expect(sut.has('symlinkRef'.toLowerCase())).toBe(true);
        expect(sut.has('badReftableTableName'.toLowerCase())).toBe(true);
        expect(sut.has('noSuchThing'.toLowerCase())).toBe(false);
      });
    });
  });
});
