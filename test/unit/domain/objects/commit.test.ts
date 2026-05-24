import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Commit } from '../../../../src/domain/objects/commit.js';
import {
  parseCommitContent,
  serializeCommitContent,
} from '../../../../src/domain/objects/commit.js';
import { encode } from '../../../../src/domain/objects/encoding.js';
import { TsgitError } from '../../../../src/domain/objects/error.js';
import { ObjectId } from '../../../../src/domain/objects/object-id.js';
import { arbObjectId } from './arbitraries.js';

const DUMMY_ID = ObjectId.from('a'.repeat(40));
const TREE_ID = ObjectId.from('b'.repeat(40));
const PARENT_ID = ObjectId.from('c'.repeat(40));

function commitText(lines: string[]): Uint8Array {
  return encode(lines.join('\n'));
}

describe('commit', () => {
  describe('parseCommitContent', () => {
    it('Given a minimal commit (tree + author + committer + message), When parsing, Then all fields correct and extraHeaders is empty array', () => {
      // Arrange
      const content = commitText([
        `tree ${'b'.repeat(40)}`,
        'author Alice <alice@test.com> 1000 +0000',
        'committer Bob <bob@test.com> 2000 +0100',
        '',
        'Initial commit',
      ]);

      // Act
      const sut = parseCommitContent(DUMMY_ID, content);

      // Assert
      expect(sut.data.tree).toBe('b'.repeat(40));
      expect(sut.data.author.name).toBe('Alice');
      expect(sut.data.committer.name).toBe('Bob');
      expect(sut.data.message).toBe('Initial commit');
      expect(sut.data.parents).toEqual([]);
      expect(sut.data.extraHeaders).toEqual([]);
      expect(sut.data.gpgSignature).toBeUndefined();
    });

    it('Given a commit with 0 parents (root commit), When parsing, Then parents is empty array', () => {
      // Arrange
      const content = commitText([
        `tree ${'b'.repeat(40)}`,
        'author A <a@a.com> 0 +0000',
        'committer A <a@a.com> 0 +0000',
        '',
        'root',
      ]);

      // Act
      const sut = parseCommitContent(DUMMY_ID, content);

      // Assert
      expect(sut.data.parents).toEqual([]);
    });

    it('Given a commit with 1 parent, When parsing, Then parents has one entry', () => {
      // Arrange
      const content = commitText([
        `tree ${'b'.repeat(40)}`,
        `parent ${'c'.repeat(40)}`,
        'author A <a@a.com> 0 +0000',
        'committer A <a@a.com> 0 +0000',
        '',
        'child',
      ]);

      // Act
      const sut = parseCommitContent(DUMMY_ID, content);

      // Assert
      expect(sut.data.parents).toEqual(['c'.repeat(40)]);
    });

    it('Given a commit with 3 parents (octopus merge), When parsing, Then parents has three entries', () => {
      // Arrange
      const p1 = '1'.repeat(40);
      const p2 = '2'.repeat(40);
      const p3 = '3'.repeat(40);
      const content = commitText([
        `tree ${'b'.repeat(40)}`,
        `parent ${p1}`,
        `parent ${p2}`,
        `parent ${p3}`,
        'author A <a@a.com> 0 +0000',
        'committer A <a@a.com> 0 +0000',
        '',
        'octopus',
      ]);

      // Act
      const sut = parseCommitContent(DUMMY_ID, content);

      // Assert
      expect(sut.data.parents).toEqual([p1, p2, p3]);
    });

    it('Given a commit with gpgsig header, When parsing, Then gpgSignature contains the full signature', () => {
      // Arrange
      const content = commitText([
        `tree ${'b'.repeat(40)}`,
        'author A <a@a.com> 0 +0000',
        'committer A <a@a.com> 0 +0000',
        'gpgsig -----BEGIN PGP SIGNATURE-----',
        ' ',
        ' iQEz',
        ' -----END PGP SIGNATURE-----',
        '',
        'signed',
      ]);

      // Act
      const sut = parseCommitContent(DUMMY_ID, content);

      // Assert
      expect(sut.data.gpgSignature).toContain('-----BEGIN PGP SIGNATURE-----');
      expect(sut.data.gpgSignature).toContain('-----END PGP SIGNATURE-----');
    });

    it('Given a commit with gpgsig header, When parsing, Then extraHeaders does NOT contain gpgsig', () => {
      // Arrange
      const content = commitText([
        `tree ${'b'.repeat(40)}`,
        'author A <a@a.com> 0 +0000',
        'committer A <a@a.com> 0 +0000',
        'gpgsig -----BEGIN PGP SIGNATURE-----',
        ' -----END PGP SIGNATURE-----',
        '',
        'signed',
      ]);

      // Act
      const sut = parseCommitContent(DUMMY_ID, content);

      // Assert
      expect(sut.data.extraHeaders.some((h) => h.key === 'gpgsig')).toBe(false);
    });

    it('Given gpgsig with continuation lines (leading space), When parsing, Then spaces are stripped from each line', () => {
      // Arrange
      const content = commitText([
        `tree ${'b'.repeat(40)}`,
        'author A <a@a.com> 0 +0000',
        'committer A <a@a.com> 0 +0000',
        'gpgsig line1',
        ' line2',
        ' line3',
        '',
        'msg',
      ]);

      // Act
      const sut = parseCommitContent(DUMMY_ID, content);

      // Assert
      expect(sut.data.gpgSignature).toBe('line1\nline2\nline3');
    });

    it('Given gpgsig with blank lines inside PGP block, When parsing, Then blank continuation lines (just 0x20) are preserved as empty lines', () => {
      // Arrange
      const content = commitText([
        `tree ${'b'.repeat(40)}`,
        'author A <a@a.com> 0 +0000',
        'committer A <a@a.com> 0 +0000',
        'gpgsig start',
        ' ',
        ' end',
        '',
        'msg',
      ]);

      // Act
      const sut = parseCommitContent(DUMMY_ID, content);

      // Assert
      expect(sut.data.gpgSignature).toBe('start\n\nend');
    });

    it('Given a commit with encoding header, When parsing, Then encoding is in extraHeaders', () => {
      // Arrange
      const content = commitText([
        `tree ${'b'.repeat(40)}`,
        'author A <a@a.com> 0 +0000',
        'committer A <a@a.com> 0 +0000',
        'encoding ISO-8859-1',
        '',
        'msg',
      ]);

      // Act
      const sut = parseCommitContent(DUMMY_ID, content);

      // Assert
      expect(sut.data.extraHeaders).toEqual([{ key: 'encoding', value: 'ISO-8859-1' }]);
    });

    it('Given a commit with gpgsig followed by encoding header, When parsing, Then gpgsig extracted and encoding in extraHeaders', () => {
      // Arrange — tests that continuation parsing stops at non-continuation line
      const content = commitText([
        `tree ${'b'.repeat(40)}`,
        'author A <a@a.com> 0 +0000',
        'committer A <a@a.com> 0 +0000',
        'gpgsig sig-line1',
        ' sig-line2',
        'encoding UTF-8',
        '',
        'msg',
      ]);

      // Act
      const sut = parseCommitContent(DUMMY_ID, content);

      // Assert
      expect(sut.data.gpgSignature).toBe('sig-line1\nsig-line2');
      expect(sut.data.extraHeaders).toEqual([{ key: 'encoding', value: 'UTF-8' }]);
    });

    it('Given a commit with two separate continuation headers, When parsing, Then each is parsed independently', () => {
      // Arrange — gpgsig with continuation, then mergetag with continuation
      // Ensures continuation parsing stops at the non-continuation line between them
      const content = commitText([
        `tree ${'b'.repeat(40)}`,
        'author A <a@a.com> 0 +0000',
        'committer A <a@a.com> 0 +0000',
        'gpgsig sig-start',
        ' sig-end',
        'mergetag merge-start',
        ' merge-end',
        '',
        'msg',
      ]);

      // Act
      const sut = parseCommitContent(DUMMY_ID, content);

      // Assert
      expect(sut.data.gpgSignature).toBe('sig-start\nsig-end');
      expect(sut.data.extraHeaders).toEqual([{ key: 'mergetag', value: 'merge-start\nmerge-end' }]);
    });

    it('Given a commit with mergetag header (multi-line), When parsing, Then mergetag is in extraHeaders with continuation lines joined', () => {
      // Arrange
      const content = commitText([
        `tree ${'b'.repeat(40)}`,
        'author A <a@a.com> 0 +0000',
        'committer A <a@a.com> 0 +0000',
        'mergetag object abc',
        ' type commit',
        ' tag v1.0',
        '',
        'merge',
      ]);

      // Act
      const sut = parseCommitContent(DUMMY_ID, content);

      // Assert
      expect(sut.data.extraHeaders).toEqual([
        {
          key: 'mergetag',
          value: 'object abc\ntype commit\ntag v1.0',
        },
      ]);
    });

    it('Given a commit with unknown extra header, When parsing, Then it is preserved in extraHeaders', () => {
      // Arrange
      const content = commitText([
        `tree ${'b'.repeat(40)}`,
        'author A <a@a.com> 0 +0000',
        'committer A <a@a.com> 0 +0000',
        'custom-header some-value',
        '',
        'msg',
      ]);

      // Act
      const sut = parseCommitContent(DUMMY_ID, content);

      // Assert
      expect(sut.data.extraHeaders).toEqual([{ key: 'custom-header', value: 'some-value' }]);
    });

    it('Given content with missing tree field, When parsing, Then throws INVALID_COMMIT with first line must be tree reason', () => {
      // Arrange
      const content = commitText([
        'author A <a@a.com> 0 +0000',
        'committer A <a@a.com> 0 +0000',
        '',
        'msg',
      ]);

      // Act & Assert
      // Assert
      expect(() => parseCommitContent(DUMMY_ID, content)).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({
            code: 'INVALID_COMMIT',
            reason: 'first line must be tree',
          }),
        }),
      );
    });

    it('Given content with tree not as first line, When parsing, Then throws INVALID_COMMIT with first line must be tree reason', () => {
      // Arrange
      const content = commitText([
        'author A <a@a.com> 0 +0000',
        `tree ${'b'.repeat(40)}`,
        'committer A <a@a.com> 0 +0000',
        '',
        'msg',
      ]);

      // Act & Assert
      // Assert
      expect(() => parseCommitContent(DUMMY_ID, content)).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({
            code: 'INVALID_COMMIT',
            reason: 'first line must be tree',
          }),
        }),
      );
    });

    it('Given content with missing author, When parsing, Then throws INVALID_COMMIT with missing author reason', () => {
      // Arrange
      const content = commitText([
        `tree ${'b'.repeat(40)}`,
        'committer A <a@a.com> 0 +0000',
        '',
        'msg',
      ]);

      // Act & Assert
      // Assert
      expect(() => parseCommitContent(DUMMY_ID, content)).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({
            code: 'INVALID_COMMIT',
            reason: 'missing author',
          }),
        }),
      );
    });

    it('Given content with wrong line where committer expected, When parsing, Then throws INVALID_COMMIT with missing committer reason', () => {
      // Arrange — enough lines, but the committer line is wrong
      const content = commitText([
        `tree ${'b'.repeat(40)}`,
        'author A <a@a.com> 0 +0000',
        'notcommitter B <b@b.com> 0 +0000',
        '',
        'msg',
      ]);

      // Act
      let sut: unknown;
      try {
        parseCommitContent(DUMMY_ID, content);
      } catch (e) {
        sut = e;
      }

      // Assert
      expect(sut).toBeInstanceOf(TsgitError);
      expect((sut as TsgitError).data).toEqual({
        code: 'INVALID_COMMIT',
        reason: 'missing committer',
      });
    });

    it('Given content with missing committer (end of headers), When parsing, Then throws INVALID_COMMIT with missing committer reason', () => {
      // Arrange
      const content = commitText([
        `tree ${'b'.repeat(40)}`,
        'author A <a@a.com> 0 +0000',
        '',
        'msg',
      ]);

      // Act
      let sut: unknown;
      try {
        parseCommitContent(DUMMY_ID, content);
      } catch (e) {
        sut = e;
      }

      // Assert
      expect(sut).toBeInstanceOf(TsgitError);
      expect((sut as TsgitError).data).toEqual({
        code: 'INVALID_COMMIT',
        reason: 'missing committer',
      });
    });

    it('Given content with empty lines (no headers at all), When parsing, Then throws INVALID_COMMIT with first line must be tree reason', () => {
      // Arrange
      const content = commitText(['', 'msg']);

      // Act & Assert
      // Assert
      expect(() => parseCommitContent(DUMMY_ID, content)).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({
            code: 'INVALID_COMMIT',
            reason: 'first line must be tree',
          }),
        }),
      );
    });

    it('Given content with tree and parents but author line is blank, When parsing, Then throws INVALID_COMMIT with missing author reason', () => {
      // Arrange
      const content = commitText([`tree ${'b'.repeat(40)}`, `parent ${'c'.repeat(40)}`, '', 'msg']);

      // Act & Assert
      // Assert
      expect(() => parseCommitContent(DUMMY_ID, content)).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({
            code: 'INVALID_COMMIT',
            reason: 'missing author',
          }),
        }),
      );
    });

    it('Given content with only tree and author but no committer line at all, When parsing, Then throws INVALID_COMMIT with missing committer reason', () => {
      // Arrange -- no blank line so entire text is treated as headerPart
      const content = commitText([`tree ${'b'.repeat(40)}`, 'author A <a@a.com> 0 +0000']);

      // Act & Assert
      // Assert
      expect(() => parseCommitContent(DUMMY_ID, content)).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({
            code: 'INVALID_COMMIT',
            reason: 'missing committer',
          }),
        }),
      );
    });

    it('Given commit with duplicate gpgsig header, When parsing, Then throws INVALID_COMMIT with duplicate gpgsig header reason', () => {
      // Arrange
      const content = commitText([
        `tree ${'b'.repeat(40)}`,
        'author A <a@a.com> 0 +0000',
        'committer A <a@a.com> 0 +0000',
        'gpgsig first-sig',
        'gpgsig second-sig',
        '',
        'msg',
      ]);

      // Act & Assert
      // Assert
      expect(() => parseCommitContent(DUMMY_ID, content)).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({
            code: 'INVALID_COMMIT',
            reason: 'duplicate gpgsig header',
          }),
        }),
      );
    });

    it('Given commit with orphan continuation line (no preceding header), When parsing, Then throws INVALID_COMMIT with unexpected continuation line reason', () => {
      // Arrange
      const content = commitText([
        `tree ${'b'.repeat(40)}`,
        'author A <a@a.com> 0 +0000',
        'committer A <a@a.com> 0 +0000',
        ' orphan continuation',
        '',
        'msg',
      ]);

      // Act & Assert
      // Assert
      expect(() => parseCommitContent(DUMMY_ID, content)).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({
            code: 'INVALID_COMMIT',
            reason: 'unexpected continuation line without preceding header',
          }),
        }),
      );
    });

    it('Given a commit with empty message, When parsing, Then message is empty string', () => {
      // Arrange — use encode directly to produce "headers\n\n" (blank line separator + empty message)
      const content = encode(
        `tree ${'b'.repeat(40)}\nauthor A <a@a.com> 0 +0000\ncommitter A <a@a.com> 0 +0000\n\n`,
      );

      // Act
      const sut = parseCommitContent(DUMMY_ID, content);

      // Assert
      expect(sut.data.message).toBe('');
    });

    it('Given a commit with message without trailing newline, When parsing, Then message has no trailing newline', () => {
      // Arrange
      const content = commitText([
        `tree ${'b'.repeat(40)}`,
        'author A <a@a.com> 0 +0000',
        'committer A <a@a.com> 0 +0000',
        '',
        'no trailing newline',
      ]);

      // Act
      const sut = parseCommitContent(DUMMY_ID, content);

      // Assert
      expect(sut.data.message).toBe('no trailing newline');
    });
  });

  describe('serializeCommitContent', () => {
    it('Given a commit, When serializing, Then gpgsig is written with continuation lines (leading space per line)', () => {
      // Arrange
      const commit: Commit = {
        type: 'commit',
        id: DUMMY_ID,
        data: {
          tree: TREE_ID,
          parents: [],
          author: {
            name: 'A',
            email: 'a@a.com',
            timestamp: 0,
            timezoneOffset: '+0000',
          },
          committer: {
            name: 'A',
            email: 'a@a.com',
            timestamp: 0,
            timezoneOffset: '+0000',
          },
          message: 'msg',
          gpgSignature: 'line1\nline2\nline3',
          extraHeaders: [],
        },
      };

      // Act
      const sut = new TextDecoder().decode(serializeCommitContent(commit));

      // Assert
      expect(sut).toContain('gpgsig line1\n line2\n line3\n');
    });

    it('Given a commit, When serializing, Then extraHeaders appear after committer, before blank line, with continuation lines', () => {
      // Arrange
      const commit: Commit = {
        type: 'commit',
        id: DUMMY_ID,
        data: {
          tree: TREE_ID,
          parents: [],
          author: {
            name: 'A',
            email: 'a@a.com',
            timestamp: 0,
            timezoneOffset: '+0000',
          },
          committer: {
            name: 'A',
            email: 'a@a.com',
            timestamp: 0,
            timezoneOffset: '+0000',
          },
          message: 'msg',
          extraHeaders: [
            {
              key: 'mergetag',
              value: 'line1\nline2',
            },
          ],
        },
      };

      // Act
      const sut = new TextDecoder().decode(serializeCommitContent(commit));

      // Assert
      expect(sut).toContain('mergetag line1\n line2\n');
    });
  });

  describe('roundtrip', () => {
    it('Given a commit, When roundtripping parse(serialize(commit)), Then all fields match byte-for-byte', () => {
      // Arrange
      const commit: Commit = {
        type: 'commit',
        id: DUMMY_ID,
        data: {
          tree: TREE_ID,
          parents: [PARENT_ID],
          author: {
            name: 'Alice',
            email: 'alice@test.com',
            timestamp: 1000,
            timezoneOffset: '+0200',
          },
          committer: {
            name: 'Bob',
            email: 'bob@test.com',
            timestamp: 2000,
            timezoneOffset: '-0500',
          },
          message: 'test commit\n\nwith body',
          gpgSignature: '-----BEGIN PGP SIGNATURE-----\n\niQEz\n-----END PGP SIGNATURE-----',
          extraHeaders: [{ key: 'encoding', value: 'UTF-8' }],
        },
      };

      // Act
      const bytes = serializeCommitContent(commit);
      const sut = parseCommitContent(DUMMY_ID, bytes);

      // Assert
      expect(sut.data).toEqual(commit.data);
    });

    it('Given a GPG-signed commit from real git, When roundtripping, Then bytes are identical', () => {
      // Arrange
      const raw = [
        `tree ${'b'.repeat(40)}`,
        `parent ${'c'.repeat(40)}`,
        'author Test <test@test.com> 1609459200 +0000',
        'committer Test <test@test.com> 1609459200 +0000',
        'gpgsig -----BEGIN PGP SIGNATURE-----',
        ' ',
        ' wsBcBAAB',
        ' -----END PGP SIGNATURE-----',
        '',
        'Signed commit message\n',
      ].join('\n');
      const content = encode(raw);

      // Act
      const parsed = parseCommitContent(DUMMY_ID, content);
      const sut = serializeCommitContent(parsed);

      // Assert
      expect(sut).toEqual(content);
    });
  });

  describe('property-based tests', () => {
    it('Roundtrip: parseCommitContent(id, serializeCommitContent(commit)) preserves all fields', () => {
      // Arrange
      const arbIdentity = fc.record({
        name: fc
          .string({ maxLength: 20 })
          .filter((s) => !s.includes('<') && !s.includes('>') && !s.includes('\n')),
        email: fc
          .string({ maxLength: 20 })
          .filter(
            (s) => !s.includes('<') && !s.includes('>') && !s.includes(' ') && !s.includes('\n'),
          ),
        timestamp: fc.integer({ min: 0, max: 9999999999 }),
        timezoneOffset: fc
          .tuple(fc.constantFrom('+', '-'), fc.integer({ min: 0, max: 12 }), fc.constantFrom(0, 30))
          .map(
            ([sign, h, m]) =>
              `${sign}${h.toString().padStart(2, '0')}${m.toString().padStart(2, '0')}`,
          ),
      });

      const arbCommitData = fc.record({
        tree: arbObjectId(40),
        parents: fc.array(arbObjectId(40), { maxLength: 3 }),
        author: arbIdentity,
        committer: arbIdentity,
        message: fc.string({ maxLength: 100 }).filter((s) => !s.includes('\0')),
        extraHeaders: fc.constant([] as { readonly key: string; readonly value: string }[]),
      });

      // Assert
      fc.assert(
        fc.property(arbCommitData, (data) => {
          const commit: Commit = {
            type: 'commit',
            id: DUMMY_ID,
            data,
          };
          const bytes = serializeCommitContent(commit);
          const sut = parseCommitContent(DUMMY_ID, bytes);
          expect(sut.data).toEqual(data);
        }),
      );
    });
  });
});
