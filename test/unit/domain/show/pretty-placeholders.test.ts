import { describe, expect, it } from 'vitest';

import type { AuthorIdentity, CommitData, ObjectId } from '../../../../src/domain/objects/index.js';
import {
  buildCommitFields,
  expandTemplate,
  type FieldContext,
} from '../../../../src/domain/show/pretty-placeholders.js';

const author: AuthorIdentity = {
  name: 'A U Thor',
  email: 'author@example.com',
  timestamp: 1_700_000_100,
  timezoneOffset: '+0200',
};
const committer: AuthorIdentity = {
  name: 'C O Mitter',
  email: 'committer@example.com',
  timestamp: 1_700_000_200,
  timezoneOffset: '+0000',
};

const ID = 'dc989f9ef804aeba7f0f84db263d05419abafa29' as ObjectId;
const TREE = 'ae7617af6291aabc261ad7f1f06d54044b943043' as ObjectId;
const PARENT = '2d0dc1ca224cca512ba435f0f152c5aaa3ca1141' as ObjectId;

const commit: CommitData = {
  tree: TREE,
  parents: [PARENT],
  author,
  committer,
  message: 'modify a.txt\n\nbody line one\nbody line two\n',
  extraHeaders: [],
};

const ctx: FieldContext = { id: ID, commit, dateMode: { kind: 'default' }, now: 0, refs: [] };
const fields = buildCommitFields(ctx);

describe('Given buildCommitFields', () => {
  describe('When hash and message placeholders are read', () => {
    it('Then they carry the faithful values', () => {
      // Arrange + Act + Assert
      expect(fields.H).toBe(ID);
      expect(fields.h).toBe('dc989f9');
      expect(fields.T).toBe(TREE);
      expect(fields.t).toBe('ae7617a');
      expect(fields.P).toBe(PARENT);
      expect(fields.p).toBe('2d0dc1c');
      expect(fields.s).toBe('modify a.txt');
      expect(fields.b).toBe('body line one\nbody line two\n');
      expect(fields.B).toBe(commit.message);
      expect(fields.f).toBe('modify-a-txt');
    });
  });

  describe('When author/committer placeholders are read', () => {
    it('Then idents and dates resolve', () => {
      // Arrange + Act + Assert
      expect(fields.an).toBe('A U Thor');
      expect(fields.ae).toBe('author@example.com');
      expect(fields.cn).toBe('C O Mitter');
      expect(fields.ad).toBe('Wed Nov 15 00:15:00 2023 +0200');
      expect(fields.aD).toBe('Wed, 15 Nov 2023 00:15:00 +0200');
      expect(fields.ai).toBe('2023-11-15 00:15:00 +0200');
      expect(fields.at).toBe('1700000100');
      expect(fields.as).toBe('2023-11-15');
    });
  });
});

describe('Given expandTemplate', () => {
  describe('When one- and two-letter codes are mixed', () => {
    it('Then each resolves and %d (decoration) is not confused with %ad', () => {
      // Arrange + Act
      const sut = expandTemplate('%h %s|%ad|%d|', fields);

      // Assert — empty decoration, so %d is empty.
      expect(sut).toBe('dc989f9 modify a.txt|Wed Nov 15 00:15:00 2023 +0200||');
    });
  });

  describe('When literals and hex bytes are used', () => {
    it('Then %% %n %xXX render their literals', () => {
      // Arrange + Act + Assert
      expect(expandTemplate('%%%n%x41', fields)).toBe('%\nA');
    });
  });

  describe('When an unknown placeholder appears', () => {
    it('Then it is passed through verbatim', () => {
      // Arrange + Act + Assert
      expect(expandTemplate('[%z]', fields)).toBe('[%z]');
    });
  });

  describe('When a dangling percent ends the template', () => {
    it('Then it is emitted verbatim', () => {
      // Arrange + Act + Assert
      expect(expandTemplate('end%', fields)).toBe('end%');
    });
  });

  describe('When %x is not followed by two hex digits', () => {
    it('Then the percent is emitted and the rest stays literal', () => {
      // Arrange + Act + Assert
      expect(expandTemplate('%xZZ', fields)).toBe('%xZZ');
    });
  });
});

describe('Given a commit with no body', () => {
  describe('When %b is read', () => {
    it('Then it is empty', () => {
      // Arrange
      const noBody = buildCommitFields({
        ...ctx,
        commit: { ...commit, message: 'subject only\n' },
      });

      // Act + Assert
      expect(noBody.b).toBe('');
    });
  });
});

describe('Given a commit with an encoding header', () => {
  describe('When %e is read', () => {
    it('Then it returns the encoding value', () => {
      // Arrange
      const withEncoding = buildCommitFields({
        ...ctx,
        commit: { ...commit, extraHeaders: [{ key: 'encoding', value: 'ISO-8859-1' }] },
      });

      // Act + Assert
      expect(withEncoding.e).toBe('ISO-8859-1');
    });
  });
});
