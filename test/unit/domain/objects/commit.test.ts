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
    describe('Given a minimal commit (tree + author + committer + message)', () => {
      describe('When parsing', () => {
        it('Then all fields correct and extraHeaders is empty array', () => {
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
      });
    });

    describe('Given a commit with 0, 1, or 3 parents', () => {
      describe('When parsing', () => {
        it.each([
          { parents: [], label: '0 parents (root commit) yields an empty array' },
          { parents: ['c'.repeat(40)], label: '1 parent yields a single entry' },
          {
            parents: ['1'.repeat(40), '2'.repeat(40), '3'.repeat(40)],
            label: '3 parents (octopus merge) yields three entries',
          },
        ])('Then $label', ({ parents }) => {
          // Arrange
          const content = commitText([
            `tree ${'b'.repeat(40)}`,
            ...parents.map((p) => `parent ${p}`),
            'author A <a@a.com> 0 +0000',
            'committer A <a@a.com> 0 +0000',
            '',
            'msg',
          ]);

          // Act
          const sut = parseCommitContent(DUMMY_ID, content);

          // Assert
          expect(sut.data.parents).toEqual(parents);
        });
      });
    });

    describe('Given a commit with gpgsig header', () => {
      describe('When parsing', () => {
        it('Then gpgSignature contains the full signature', () => {
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
        it('Then extraHeaders does NOT contain gpgsig', () => {
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
      });
    });

    describe('Given gpgsig with continuation lines (leading space)', () => {
      describe('When parsing', () => {
        it('Then spaces are stripped from each line', () => {
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
      });
    });

    describe('Given gpgsig with blank lines inside PGP block', () => {
      describe('When parsing', () => {
        it('Then blank continuation lines (just 0x20) are preserved as empty lines', () => {
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
      });
    });

    describe('Given a commit with encoding header', () => {
      describe('When parsing', () => {
        it('Then encoding is in extraHeaders', () => {
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
      });
    });

    describe('Given a commit with gpgsig followed by encoding header', () => {
      describe('When parsing', () => {
        it('Then gpgsig extracted and encoding in extraHeaders', () => {
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
      });
    });

    describe('Given a commit with two separate continuation headers', () => {
      describe('When parsing', () => {
        it('Then each is parsed independently', () => {
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
          expect(sut.data.extraHeaders).toEqual([
            { key: 'mergetag', value: 'merge-start\nmerge-end' },
          ]);
        });
      });
    });

    describe('Given a commit with mergetag header (multi-line)', () => {
      describe('When parsing', () => {
        it('Then mergetag is in extraHeaders with continuation lines joined', () => {
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
      });
    });

    describe('Given a commit with unknown extra header', () => {
      describe('When parsing', () => {
        it('Then it is preserved in extraHeaders', () => {
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
      });
    });

    // Each row isolates one distinct parseCommitContent validation guard (the
    // three 'first line must be tree' rows differ in *how* line 0 fails to
    // start with 'tree ' — absent, misplaced, or blank — but all trip the same
    // single guard, so none is a merge of two conditions).
    describe('Given content that fails a parseCommitContent validation guard', () => {
      describe('When parsing', () => {
        it.each([
          {
            label: 'a missing tree field',
            reason: 'first line must be tree',
            lines: ['author A <a@a.com> 0 +0000', 'committer A <a@a.com> 0 +0000', '', 'msg'],
          },
          {
            label: 'tree present but not as the first line',
            reason: 'first line must be tree',
            lines: [
              'author A <a@a.com> 0 +0000',
              `tree ${'b'.repeat(40)}`,
              'committer A <a@a.com> 0 +0000',
              '',
              'msg',
            ],
          },
          {
            label: 'no headers at all (first line blank)',
            reason: 'first line must be tree',
            lines: ['', 'msg'],
          },
          {
            label: 'a missing author',
            reason: 'missing author',
            lines: [`tree ${'b'.repeat(40)}`, 'committer A <a@a.com> 0 +0000', '', 'msg'],
          },
          {
            label: 'tree and parents but a blank author line',
            reason: 'missing author',
            lines: [`tree ${'b'.repeat(40)}`, `parent ${'c'.repeat(40)}`, '', 'msg'],
          },
          {
            label: 'only tree and author, no committer line at all',
            reason: 'missing committer',
            // no blank line, so the entire text is treated as headerPart
            lines: [`tree ${'b'.repeat(40)}`, 'author A <a@a.com> 0 +0000'],
          },
          {
            label: 'a duplicate gpgsig header',
            reason: 'duplicate gpgsig header',
            lines: [
              `tree ${'b'.repeat(40)}`,
              'author A <a@a.com> 0 +0000',
              'committer A <a@a.com> 0 +0000',
              'gpgsig first-sig',
              'gpgsig second-sig',
              '',
              'msg',
            ],
          },
          {
            label: 'an orphan continuation line (no preceding header)',
            reason: 'unexpected continuation line without preceding header',
            lines: [
              `tree ${'b'.repeat(40)}`,
              'author A <a@a.com> 0 +0000',
              'committer A <a@a.com> 0 +0000',
              ' orphan continuation',
              '',
              'msg',
            ],
          },
        ])('Then throws INVALID_COMMIT for $label', ({ lines, reason }) => {
          // Arrange
          const content = commitText(lines);

          // Act + Assert
          expect(() => parseCommitContent(DUMMY_ID, content)).toThrow(
            expect.objectContaining({
              data: expect.objectContaining({
                code: 'INVALID_COMMIT',
                reason,
              }),
            }),
          );
        });
      });
    });

    // 'the committer line is wrong' trips `!lines[i].startsWith('committer ')`
    // with i in bounds. 'the committer line is blank' looks like the same
    // sub-condition from the array literal, but splitHeaderAndMessage's blank
    // line is the header/message separator itself — it never becomes a line —
    // so headerPart ends after 'author A …' and this row actually re-exercises
    // the `i >= lines.length` OOB branch, same as 'only tree and author, no
    // committer line at all' above (hand-verified: both fail identically when
    // the OOB check is removed).
    describe('Given content missing a valid committer line, with more lines still to read', () => {
      describe('When parsing', () => {
        it.each([
          {
            label: 'the committer line is wrong',
            lines: [
              `tree ${'b'.repeat(40)}`,
              'author A <a@a.com> 0 +0000',
              'notcommitter B <b@b.com> 0 +0000',
              '',
              'msg',
            ],
          },
          {
            label: 'the committer line is blank',
            lines: [`tree ${'b'.repeat(40)}`, 'author A <a@a.com> 0 +0000', '', 'msg'],
          },
        ])('Then throws INVALID_COMMIT with missing committer reason when $label', ({ lines }) => {
          // Arrange
          const content = commitText(lines);

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
      });
    });

    describe('Given a commit with empty message', () => {
      describe('When parsing', () => {
        it('Then message is empty string', () => {
          // Arrange — use encode directly to produce "headers\n\n" (blank line separator + empty message)
          const content = encode(
            `tree ${'b'.repeat(40)}\nauthor A <a@a.com> 0 +0000\ncommitter A <a@a.com> 0 +0000\n\n`,
          );

          // Act
          const sut = parseCommitContent(DUMMY_ID, content);

          // Assert
          expect(sut.data.message).toBe('');
        });
      });
    });

    describe('Given a commit with message without trailing newline', () => {
      describe('When parsing', () => {
        it('Then message has no trailing newline', () => {
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
    });
  });

  describe('serializeCommitContent', () => {
    describe('Given a commit', () => {
      describe('When serializing', () => {
        it('Then gpgsig is written with continuation lines (leading space per line)', () => {
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
        it('Then extraHeaders appear after committer, before blank line, with continuation lines', () => {
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
    });
  });

  describe('roundtrip', () => {
    describe('Given a commit', () => {
      describe('When roundtripping parse(serialize(commit))', () => {
        it('Then all fields match byte-for-byte', () => {
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
      });
    });

    describe('Given a GPG-signed commit from real git', () => {
      describe('When roundtripping', () => {
        it('Then bytes are identical', () => {
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
    });
  });

  describe('property-based tests', () => {
    describe('Given the roundtrip property "parseCommitContent(id, serializeCommitContent(commit)) preserves all fields"', () => {
      describe('When sampled', () => {
        it('Then it holds', () => {
          // Arrange
          const arbIdentity = fc.record({
            name: fc
              .string({ maxLength: 20 })
              .filter((s) => !s.includes('<') && !s.includes('>') && !s.includes('\n')),
            email: fc
              .string({ maxLength: 20 })
              .filter(
                (s) =>
                  !s.includes('<') && !s.includes('>') && !s.includes(' ') && !s.includes('\n'),
              ),
            timestamp: fc.integer({ min: 0, max: 9999999999 }),
            timezoneOffset: fc
              .tuple(
                fc.constantFrom('+', '-'),
                fc.integer({ min: 0, max: 12 }),
                fc.constantFrom(0, 30),
              )
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
  });
});
