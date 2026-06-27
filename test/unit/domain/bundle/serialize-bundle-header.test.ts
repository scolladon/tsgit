import { describe, expect, it } from 'vitest';

import { serializeBundleHeader } from '../../../../src/domain/bundle/serialize-bundle-header.js';
import type { BundlePrerequisite, BundleRef } from '../../../../src/domain/bundle/types.js';
import { ObjectId, RefName } from '../../../../src/domain/objects/object-id.js';

const OID_A = ObjectId.from('a'.repeat(40));
const OID_B = ObjectId.from('b'.repeat(40));
const OID_C = ObjectId.from('c'.repeat(40));
const OID_D = ObjectId.from('d'.repeat(40));

const REF_MAIN = RefName.from('refs/heads/main');
const REF_FEATURE = RefName.from('refs/heads/feature');
const REF_HEAD = RefName.from('HEAD');

describe('Given serializeBundleHeader', () => {
  describe('When called with no prerequisites and one ref', () => {
    it('Then emits magic, ref line and blank line', () => {
      // Arrange
      const sut = serializeBundleHeader;
      const refs: ReadonlyArray<BundleRef> = [{ oid: OID_B, name: REF_MAIN }];

      // Act
      const result = sut({ version: 2, prerequisites: [], refs });

      // Assert
      const expected = new TextEncoder().encode(`# v2 git bundle\n${OID_B} refs/heads/main\n\n`);
      expect(result).toEqual(expected);
    });
  });

  describe('When called with prerequisites in reverse oid order', () => {
    it('Then prerequisite lines are sorted by oid ascending', () => {
      // Arrange
      const sut = serializeBundleHeader;
      const prerequisites: ReadonlyArray<BundlePrerequisite> = [
        { oid: OID_C, comment: 'third commit' },
        { oid: OID_A, comment: 'first commit' },
      ];
      const refs: ReadonlyArray<BundleRef> = [{ oid: OID_D, name: REF_MAIN }];

      // Act
      const result = sut({ version: 2, prerequisites, refs });

      // Assert
      const expected = new TextEncoder().encode(
        [
          '# v2 git bundle',
          `-${OID_A} first commit`,
          `-${OID_C} third commit`,
          `${OID_D} refs/heads/main`,
          '',
          '',
        ].join('\n'),
      );
      expect(result).toEqual(expected);
    });
  });

  describe('When called with multiple refs', () => {
    it('Then ref lines preserve input order without sorting', () => {
      // Arrange
      const sut = serializeBundleHeader;
      const refs: ReadonlyArray<BundleRef> = [
        { oid: OID_B, name: REF_MAIN },
        { oid: OID_A, name: REF_FEATURE },
      ];

      // Act
      const result = sut({ version: 2, prerequisites: [], refs });

      // Assert
      const text = new TextDecoder().decode(result);
      const lines = text.split('\n');
      expect(lines[0]).toBe('# v2 git bundle');
      expect(lines[1]).toBe(`${OID_B} refs/heads/main`);
      expect(lines[2]).toBe(`${OID_A} refs/heads/feature`);
      expect(lines[3]).toBe('');
      expect(lines[4]).toBe('');
    });
  });

  describe('When called with HEAD ref', () => {
    it('Then HEAD is emitted as a ref line', () => {
      // Arrange
      const sut = serializeBundleHeader;
      const refs: ReadonlyArray<BundleRef> = [{ oid: OID_B, name: REF_HEAD }];

      // Act
      const result = sut({ version: 2, prerequisites: [], refs });

      // Assert
      const text = new TextDecoder().decode(result);
      expect(text).toContain(`${OID_B} HEAD\n`);
    });
  });

  describe('When called with a full header (prerequisites + refs)', () => {
    it('Then bytes match the exact expected format: magic, sorted prereqs, refs, blank', () => {
      // Arrange
      const sut = serializeBundleHeader;
      const prerequisites: ReadonlyArray<BundlePrerequisite> = [
        { oid: OID_B, comment: 'second' },
        { oid: OID_A, comment: 'first' },
      ];
      const refs: ReadonlyArray<BundleRef> = [
        { oid: OID_C, name: REF_MAIN },
        { oid: OID_D, name: REF_HEAD },
      ];

      // Act
      const result = sut({ version: 2, prerequisites, refs });

      // Assert
      const text = new TextDecoder().decode(result);
      expect(text).toBe(
        `# v2 git bundle\n-${OID_A} first\n-${OID_B} second\n${OID_C} refs/heads/main\n${OID_D} HEAD\n\n`,
      );
    });
  });
});
