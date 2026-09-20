// cspell:ignore xree xfiller xbject xtype
import { describe, expect, it } from 'vitest';
import {
  feedParseAcceptance,
  needsParentLookups,
  parseAcceptanceVerdict,
  startParseAcceptance,
} from '../../../../src/domain/objects/parse-acceptance.js';

const ENC = new TextEncoder();

const scanCommit = (hexLength: 40 | 64, body: string | Uint8Array) =>
  feedParseAcceptance(
    startParseAcceptance('commit', hexLength),
    typeof body === 'string' ? ENC.encode(body) : body,
  );

const scanTag = (hexLength: 40 | 64, body: string | Uint8Array) =>
  feedParseAcceptance(
    startParseAcceptance('tag', hexLength),
    typeof body === 'string' ? ENC.encode(body) : body,
  );

const CHECKED = { parentLookups: 'checked' } as const;
const SKIPPED = { parentLookups: 'skipped' } as const;

const BAD_TREE_POINTER = { type: 'commit', reason: 'bad tree pointer' } as const;

// Alternating digit/letter by default so the ordinary "accepted" rows cover
// both `isHexByte` ranges without a dedicated test for either; a single-char
// `fill` (used where a row just needs a SECOND, distinct id) still repeats
// as before.
const T = (hexLength: 40 | 64, fill = '1a'): string =>
  fill.repeat(Math.ceil(hexLength / fill.length)).slice(0, hexLength);

describe('parse-acceptance', () => {
  describe('commit — bogus commit object', () => {
    describe('Given a body of exactly h + 6 bytes', () => {
      describe('When the verdict is read', () => {
        it.each([{ h: 40 as const }, { h: 64 as const }])(
          'Then it refuses bogus commit object (h=$h)',
          ({ h }) => {
            // Arrange
            const sut = parseAcceptanceVerdict;
            const scan = scanCommit(h, `tree ${T(h)}\n`);

            // Act
            const result = sut(scan, CHECKED);

            // Assert
            expect(result).toEqual({ type: 'commit', reason: 'bogus commit object' });
          },
        );
      });
    });

    describe('Given a body of exactly h + 7 bytes (one byte past the tree line)', () => {
      describe('When the verdict is read', () => {
        it('Then it is accepted', () => {
          // Arrange
          const sut = parseAcceptanceVerdict;
          const scan = scanCommit(40, `tree ${T(40)}\nx`);

          // Act
          const result = sut(scan, CHECKED);

          // Assert
          expect(result).toBeUndefined();
        });
      });
    });

    describe('Given the tree prefix is wrong', () => {
      describe('When the verdict is read', () => {
        it('Then it refuses bogus commit object', () => {
          // Arrange
          const sut = parseAcceptanceVerdict;
          const scan = scanCommit(40, `xree ${T(40)}\nfiller`);

          // Act
          const result = sut(scan, CHECKED);

          // Assert
          expect(result).toEqual({ type: 'commit', reason: 'bogus commit object' });
        });
      });
    });

    describe('Given the LF at h + 5 is missing', () => {
      describe('When the verdict is read', () => {
        it('Then it refuses bogus commit object', () => {
          // Arrange
          const sut = parseAcceptanceVerdict;
          const scan = scanCommit(40, `tree ${T(40)}xfiller`);

          // Act
          const result = sut(scan, CHECKED);

          // Assert
          expect(result).toEqual({ type: 'commit', reason: 'bogus commit object' });
        });
      });
    });
  });

  describe('commit — bad tree pointer', () => {
    describe('Given a non-hex tree id', () => {
      describe('When the verdict is read', () => {
        it('Then it refuses bad tree pointer', () => {
          // Arrange
          const sut = parseAcceptanceVerdict;
          const scan = scanCommit(40, `tree ${'g'.repeat(40)}\nfiller`);

          // Act
          const result = sut(scan, CHECKED);

          // Assert
          expect(result).toEqual({ type: 'commit', reason: 'bad tree pointer' });
        });
      });
    });

    describe('Given an upper-case tree id', () => {
      describe('When the verdict is read', () => {
        it('Then it is accepted', () => {
          // Arrange
          const sut = parseAcceptanceVerdict;
          const scan = scanCommit(40, `tree ${T(40).toUpperCase()}\nfiller`);

          // Act
          const result = sut(scan, CHECKED);

          // Assert
          expect(result).toBeUndefined();
        });
      });
    });

    describe('Given a tree id whose opening bytes are hex and whose tail is not', () => {
      describe('When the verdict is read', () => {
        it('Then it refuses bad tree pointer', () => {
          // Arrange — every byte of the id is read, not just its first few.
          const sut = parseAcceptanceVerdict;
          const scan = scanCommit(40, `tree ${T(40).slice(0, 6)}${'g'.repeat(34)}\nfiller`);

          // Act
          const result = sut(scan, CHECKED);

          // Assert
          expect(result).toEqual({ type: 'commit', reason: 'bad tree pointer' });
        });
      });
    });

    // git's `get_oid_hex` reads 0-9, a-f and A-F and nothing else, so each of
    // the three ranges refuses on both of the bytes bordering it.
    const HEX_EDGE_ROWS = [
      { label: "'/', one below '0'", fill: '/', expected: BAD_TREE_POINTER },
      { label: "'0', the lowest digit", fill: '0', expected: undefined },
      { label: "'9', the highest digit", fill: '9', expected: undefined },
      { label: "':', one above '9'", fill: ':', expected: BAD_TREE_POINTER },
      { label: "'@', one below 'A'", fill: '@', expected: BAD_TREE_POINTER },
      { label: "'A', the lowest upper-case letter", fill: 'A', expected: undefined },
      { label: "'F', the highest upper-case letter", fill: 'F', expected: undefined },
      { label: "'G', one above 'F'", fill: 'G', expected: BAD_TREE_POINTER },
      { label: "'`', one below 'a'", fill: '`', expected: BAD_TREE_POINTER },
      { label: "'a', the lowest lower-case letter", fill: 'a', expected: undefined },
      { label: "'f', the highest lower-case letter", fill: 'f', expected: undefined },
      { label: "'g', one above 'f'", fill: 'g', expected: BAD_TREE_POINTER },
    ] as const;

    describe('Given a tree id filled with a byte bordering one of the hex ranges', () => {
      describe('When the verdict is read', () => {
        it.each(HEX_EDGE_ROWS)(
          'Then $label lands on git’s side of the range',
          ({ fill, expected }) => {
            // Arrange
            const sut = parseAcceptanceVerdict;
            const scan = scanCommit(40, `tree ${fill.repeat(40)}\nfiller`);

            // Act
            const result = sut(scan, CHECKED);

            // Assert
            expect(result).toEqual(expected);
          },
        );
      });
    });
  });

  describe('commit — bad parents', () => {
    describe('Given a parent line that is the last h + 8 bytes of the body', () => {
      describe('When the verdict is read', () => {
        it('Then it refuses bad parents', () => {
          // Arrange
          const sut = parseAcceptanceVerdict;
          const scan = scanCommit(40, `tree ${T(40)}\nparent ${T(40, 'b')}\n`);

          // Act
          const result = sut(scan, CHECKED);

          // Assert
          expect(result).toEqual({ type: 'commit', reason: 'bad parents' });
        });
      });
    });

    describe('Given a parent prefix with exactly h + 7 bytes left after the tree line', () => {
      describe('When the verdict is read', () => {
        it('Then it is accepted (the loop is not entered)', () => {
          // Arrange
          const sut = parseAcceptanceVerdict;
          const scan = scanCommit(40, `tree ${T(40)}\nparent `);

          // Act
          const result = sut(scan, CHECKED);

          // Assert
          expect(result).toBeUndefined();
        });
      });
    });

    describe('Given a non-hex parent id', () => {
      describe('When the verdict is read', () => {
        it('Then it refuses bad parents', () => {
          // Arrange
          const sut = parseAcceptanceVerdict;
          const scan = scanCommit(40, `tree ${T(40)}\nparent ${'g'.repeat(40)}\nx`);

          // Act
          const result = sut(scan, CHECKED);

          // Assert
          expect(result).toEqual({ type: 'commit', reason: 'bad parents' });
        });
      });
    });

    describe('Given the LF at p + h + 7 is missing', () => {
      describe('When the verdict is read', () => {
        it('Then it refuses bad parents', () => {
          // Arrange
          const sut = parseAcceptanceVerdict;
          const scan = scanCommit(40, `tree ${T(40)}\nparent ${T(40, 'b')}x`);

          // Act
          const result = sut(scan, CHECKED);

          // Assert
          expect(result).toEqual({ type: 'commit', reason: 'bad parents' });
        });
      });
    });

    describe('Given a well-formed first parent line and a malformed second one', () => {
      describe('When the verdict is read', () => {
        it('Then it refuses bad parents', () => {
          // Arrange
          const sut = parseAcceptanceVerdict;
          const scan = scanCommit(
            40,
            `tree ${T(40)}\nparent ${T(40, 'b')}\nparent ${'g'.repeat(40)}\nx`,
          );

          // Act
          const result = sut(scan, CHECKED);

          // Assert
          expect(result).toEqual({ type: 'commit', reason: 'bad parents' });
        });
      });
    });

    describe('Given a "parent"-prefixed line appearing after the parent lines have ended', () => {
      describe('When the verdict is read', () => {
        it('Then it is accepted — the scan never re-enters the parent loop', () => {
          // Arrange — the scan stops re-checking for "parent " lines the
          // moment one line's prefix does not match; this line's "parent "
          // text lives in what the scan already treats as unchecked tail.
          const sut = parseAcceptanceVerdict;
          const scan = scanCommit(
            40,
            `tree ${T(40)}\nauthor A <a@x> 0 +0000\nparent ${T(40, 'b')}\n`,
          );

          // Act
          const result = sut(scan, CHECKED);

          // Assert
          expect(result).toBeUndefined();
        });
      });
    });

    describe('Given a well-formed parent id with no LF and more body after it', () => {
      describe('When the verdict is read', () => {
        it('Then it refuses bad parents', () => {
          // Arrange — more bytes follow the line, so the refusal has to come
          // from the line's own terminator rather than from the verdict's
          // trailing-window check.
          const sut = parseAcceptanceVerdict;
          const scan = scanCommit(40, `tree ${T(40)}\nparent ${T(40, 'b')}xfiller\n`);

          // Act
          const result = sut(scan, CHECKED);

          // Assert
          expect(result).toEqual({ type: 'commit', reason: 'bad parents' });
        });
      });
    });
  });

  describe('commit — bad parent (parent equals tree)', () => {
    describe('Given a parent id equal to the tree id', () => {
      describe('When parentLookups is "checked"', () => {
        it('Then it refuses bad parent, with the lower-cased id in the reason', () => {
          // Arrange
          const treeHex = T(40);
          const sut = parseAcceptanceVerdict;
          const scan = scanCommit(40, `tree ${treeHex}\nparent ${treeHex.toUpperCase()}\nx`);

          // Act
          const result = sut(scan, CHECKED);

          // Assert
          expect(result).toEqual({
            type: 'commit',
            reason: `bad parent ${treeHex}`,
          });
        });
      });

      describe('When parentLookups is "skipped" (a shallow boundary)', () => {
        it('Then it is accepted', () => {
          // Arrange
          const treeHex = T(40);
          const sut = parseAcceptanceVerdict;
          const scan = scanCommit(40, `tree ${treeHex}\nparent ${treeHex}\nx`);

          // Act
          const result = sut(scan, SKIPPED);

          // Assert
          expect(result).toBeUndefined();
          expect(needsParentLookups(scan)).toBe(true);
        });
      });
    });

    describe('Given a matching parent on the first line and a grammar failure on the second', () => {
      describe('When parentLookups is "checked"', () => {
        it('Then it refuses via the earlier match', () => {
          // Arrange
          const treeHex = T(40);
          const sut = parseAcceptanceVerdict;
          const scan = scanCommit(
            40,
            `tree ${treeHex}\nparent ${treeHex}\nparent ${'g'.repeat(40)}\nx`,
          );

          // Act
          const result = sut(scan, CHECKED);

          // Assert
          expect(result).toEqual({
            type: 'commit',
            reason: `bad parent ${treeHex}`,
          });
        });
      });

      describe('When parentLookups is "skipped"', () => {
        it('Then it refuses via the later grammar failure instead', () => {
          // Arrange
          const treeHex = T(40);
          const sut = parseAcceptanceVerdict;
          const scan = scanCommit(
            40,
            `tree ${treeHex}\nparent ${treeHex}\nparent ${'g'.repeat(40)}\nx`,
          );

          // Act
          const result = sut(scan, SKIPPED);

          // Assert
          expect(result).toEqual({ type: 'commit', reason: 'bad parents' });
        });
      });
    });

    describe('Given a matching parent already found on an earlier line, and a later well-formed non-matching parent', () => {
      describe('When the verdict is read', () => {
        it('Then the first candidate is kept, not overwritten', () => {
          // Arrange — three parents: line 1 matches the tree (records it),
          // line 2 does not (the recorded match survives it), line 3 is just
          // well-formed filler.
          const treeHex = T(40);
          const sut = parseAcceptanceVerdict;
          const scan = scanCommit(
            40,
            `tree ${treeHex}\nparent ${treeHex}\nparent ${T(40, 'b')}\nparent ${T(40, 'c')}\nx`,
          );

          // Act
          const result = sut(scan, CHECKED);

          // Assert
          expect(result).toEqual({
            type: 'commit',
            reason: `bad parent ${treeHex}`,
          });
        });
      });
    });

    describe('Given a grammar failure on the first parent line and a would-be match on the second', () => {
      describe('When the verdict is read', () => {
        it('Then it refuses via the grammar failure, and needsParentLookups is false', () => {
          // Arrange — the scan stops at the first malformed line, so the
          // second line's match against the tree id is never even examined.
          const treeHex = T(40);
          const sut = parseAcceptanceVerdict;
          const scan = scanCommit(
            40,
            `tree ${treeHex}\nparent ${'g'.repeat(40)}\nparent ${treeHex}\n`,
          );

          // Act
          const result = sut(scan, CHECKED);

          // Assert
          expect(result).toEqual({ type: 'commit', reason: 'bad parents' });
          expect(needsParentLookups(scan)).toBe(false);
        });
      });
    });
  });

  describe('commit — accepted shapes git accepts', () => {
    describe('Given a commit with no author or committer line at all', () => {
      describe('When the verdict is read', () => {
        it('Then it is accepted', () => {
          // Arrange
          const sut = parseAcceptanceVerdict;
          const scan = scanCommit(40, `tree ${T(40)}\nparent ${T(40, 'b')}\n\nmessage only\n`);

          // Act
          const result = sut(scan, CHECKED);

          // Assert
          expect(result).toBeUndefined();
        });
      });
    });
  });

  describe('tag — tag object too short', () => {
    describe('Given a body of exactly h + 23 bytes', () => {
      describe('When the verdict is read', () => {
        it('Then it refuses tag object too short', () => {
          // Arrange — pad a short, otherwise-plausible prefix out to h + 23.
          const base = `object ${T(40)}\ntype `;
          const body = base + 'x'.repeat(40 + 23 - base.length);
          const sut = parseAcceptanceVerdict;
          const scan = scanTag(40, body);

          // Act
          const result = sut(scan, CHECKED);

          // Assert
          expect(result).toEqual({ type: 'tag', reason: 'tag object too short' });
        });
      });
    });

    describe('Given a body of exactly h + 24 bytes with no valid tag structure', () => {
      describe('When the verdict is read', () => {
        it('Then the too-short check does not fire, and the missing tag line refuses instead', () => {
          // Arrange
          const base = `object ${T(40)}\ntype commit\n`;
          const body = base + 'x'.repeat(40 + 24 - base.length);
          const sut = parseAcceptanceVerdict;
          const scan = scanTag(40, body);

          // Act
          const result = sut(scan, CHECKED);

          // Assert
          expect(result).toEqual({ type: 'tag', reason: 'bad tag line' });
        });
      });
    });
  });

  describe('tag — bad object line', () => {
    describe('Given the object prefix is wrong', () => {
      describe('When the verdict is read', () => {
        it('Then it refuses bad object line', () => {
          // Arrange
          const sut = parseAcceptanceVerdict;
          const scan = scanTag(40, `xbject ${T(40)}\ntype commit\ntag t\n\nmsg\n`);

          // Act
          const result = sut(scan, CHECKED);

          // Assert
          expect(result).toEqual({ type: 'tag', reason: 'bad object line' });
        });
      });
    });

    describe('Given a non-hex object id', () => {
      describe('When the verdict is read', () => {
        it('Then it refuses bad object line', () => {
          // Arrange
          const sut = parseAcceptanceVerdict;
          const scan = scanTag(40, `object ${'g'.repeat(40)}\ntype commit\ntag t\n\nmsg\n`);

          // Act
          const result = sut(scan, CHECKED);

          // Assert
          expect(result).toEqual({ type: 'tag', reason: 'bad object line' });
        });
      });
    });

    describe('Given a short (non-hex-length) object id', () => {
      describe('When the verdict is read', () => {
        it('Then it refuses bad object line', () => {
          // Arrange — one hex char short, so byte h+7 is not the expected LF.
          const sut = parseAcceptanceVerdict;
          const scan = scanTag(40, `object ${T(40).slice(0, 39)}\ntype commit\ntag t\n\nmsg\n`);

          // Act
          const result = sut(scan, CHECKED);

          // Assert
          expect(result).toEqual({ type: 'tag', reason: 'bad object line' });
        });
      });
    });

    describe('Given an object id whose opening bytes are hex and whose tail is not', () => {
      describe('When the verdict is read', () => {
        it('Then it refuses bad object line', () => {
          // Arrange — every byte of the id is read, not just its first few.
          const sut = parseAcceptanceVerdict;
          const scan = scanTag(
            40,
            `object ${T(40).slice(0, 8)}${'g'.repeat(32)}\ntype commit\ntag t\n\nmsg\n`,
          );

          // Act
          const result = sut(scan, CHECKED);

          // Assert
          expect(result).toEqual({ type: 'tag', reason: 'bad object line' });
        });
      });
    });

    describe('Given a full-length hex object id closed by a byte that is not the LF', () => {
      describe('When the verdict is read', () => {
        it('Then it refuses bad object line', () => {
          // Arrange — the id itself is beyond reproach, so only the line's
          // terminator can refuse this body.
          const sut = parseAcceptanceVerdict;
          const scan = scanTag(40, `object ${T(40)}xtype commit\ntag t\n\nmsg\n`);

          // Act
          const result = sut(scan, CHECKED);

          // Assert
          expect(result).toEqual({ type: 'tag', reason: 'bad object line' });
        });
      });
    });
  });

  describe('tag — bad type line', () => {
    describe('Given the type prefix is missing entirely', () => {
      describe('When the verdict is read', () => {
        it('Then it refuses bad type line', () => {
          // Arrange
          const sut = parseAcceptanceVerdict;
          const scan = scanTag(40, `object ${T(40)}\nnope commit\ntag t\n\nmsg\n`);

          // Act
          const result = sut(scan, CHECKED);

          // Assert
          expect(result).toEqual({ type: 'tag', reason: 'bad type line' });
        });
      });
    });

    describe('Given a type name of exactly 19 bytes', () => {
      describe('When the name is a known type padded with unknown bytes', () => {
        it('Then the type-line grammar lets it through, and only the unknown-type check refuses it', () => {
          // Arrange — 19-byte unknown name: the type-line grammar passes (an
          // LF is found in time), and the UNKNOWN-TYPE check refuses on the
          // name itself, proving the 19-byte line reached that check rather
          // than being cut off by the type-line grammar.
          const name19 = `commit${'x'.repeat(13)}`;
          expect(name19.length).toBe(19);
          const sut = parseAcceptanceVerdict;
          const scan = scanTag(40, `object ${T(40)}\ntype ${name19}\ntag t\n\nmsg\n`);

          // Act
          const result = sut(scan, CHECKED);

          // Assert
          expect(result).toEqual({
            type: 'tag',
            reason: `unknown tag type '${name19}'`,
          });
        });
      });
    });

    describe('Given a type name of exactly 20 bytes with no LF within the cap', () => {
      describe('When the verdict is read', () => {
        it('Then it refuses bad type line', () => {
          // Arrange
          const name20 = 'x'.repeat(20);
          const sut = parseAcceptanceVerdict;
          const scan = scanTag(40, `object ${T(40)}\ntype ${name20}\ntag t\n\nmsg\n`);

          // Act
          const result = sut(scan, CHECKED);

          // Assert
          expect(result).toEqual({ type: 'tag', reason: 'bad type line' });
        });
      });
    });

    describe('Given no LF ever follows the type name', () => {
      describe('When the verdict is read', () => {
        it('Then it refuses bad type line', () => {
          // Arrange — padded past h + 24 so the too-short check does not
          // preempt this row;
          // the name itself stays under the 20-byte cap, so this is decided
          // only once no more input is coming (not by the cap).
          const sut = parseAcceptanceVerdict;
          const scan = scanTag(40, `object ${T(40)}\ntype commit${'x'.repeat(8)}`);

          // Act
          const result = sut(scan, CHECKED);

          // Assert
          expect(result).toEqual({ type: 'tag', reason: 'bad type line' });
        });
      });
    });
  });

  describe('tag — unknown tag type', () => {
    describe('Given an unknown type name', () => {
      describe('When the verdict is read', () => {
        it("Then it refuses unknown tag type 'bogus'", () => {
          // Arrange
          const sut = parseAcceptanceVerdict;
          const scan = scanTag(40, `object ${T(40)}\ntype bogus\ntag t\n\nmsg\n`);

          // Act
          const result = sut(scan, CHECKED);

          // Assert
          expect(result).toEqual({ type: 'tag', reason: "unknown tag type 'bogus'" });
        });
      });
    });

    describe('Given an unknown type name containing a control character', () => {
      describe('When the verdict is read', () => {
        it('Then the reason sanitises it', () => {
          // Arrange
          const sut = parseAcceptanceVerdict;
          const scan = scanTag(40, `object ${T(40)}\ntype bo\x07gus\ntag t\n\nmsg\n`);

          // Act
          const result = sut(scan, CHECKED);

          // Assert
          expect(result).toEqual({
            type: 'tag',
            reason: "unknown tag type 'bo\\x07gus'",
          });
        });
      });
    });

    describe('Given an unknown type name followed by a NUL and more bytes', () => {
      describe('When the verdict is read', () => {
        it('Then the reason names only the bytes before the NUL', () => {
          // Arrange
          const sut = parseAcceptanceVerdict;
          const scan = scanTag(40, `object ${T(40)}\ntype bogus\0xyz\ntag t\n\nmsg\n`);

          // Act
          const result = sut(scan, CHECKED);

          // Assert
          expect(result).toEqual({ type: 'tag', reason: "unknown tag type 'bogus'" });
        });
      });
    });

    describe('Given a type name with an embedded NUL before a known type name', () => {
      describe('When the verdict is read', () => {
        it('Then it is accepted as the type before the NUL', () => {
          // Arrange
          const sut = parseAcceptanceVerdict;
          const scan = scanTag(40, `object ${T(40)}\ntype commit\0x\ntag t\n\nmsg\n`);

          // Act
          const result = sut(scan, CHECKED);

          // Assert
          expect(result).toBeUndefined();
          // A tag scan never needs a parent lookup - that concept is
          // commit-only.
          expect(needsParentLookups(scan)).toBe(false);
        });
      });
    });
  });

  describe('tag — bad tag line', () => {
    describe('Given the tag prefix is confirmed but no LF ever follows it', () => {
      describe('When the verdict is read', () => {
        it('Then it refuses bad tag line', () => {
          // Arrange — `object` + `type` line total h + 20 bytes, always
          // under h + 24 for any known type name, so the too-short check
          // would otherwise preempt this row; a confirmed `tag ` with no
          // trailing LF closes the gap without adding a byte beyond the
          // tag-line prefix itself.
          const sut = parseAcceptanceVerdict;
          const scan = scanTag(40, `object ${T(40)}\ntype commit\ntag `);

          // Act
          const result = sut(scan, CHECKED);

          // Assert
          expect(result).toEqual({ type: 'tag', reason: 'bad tag line' });
        });
      });
    });

    describe('Given "tag " followed immediately by an LF (an empty name)', () => {
      describe('When the verdict is read', () => {
        it('Then it is accepted', () => {
          // Arrange
          const sut = parseAcceptanceVerdict;
          const scan = scanTag(40, `object ${T(40)}\ntype commit\ntag \n\nmsg\n`);

          // Act
          const result = sut(scan, CHECKED);

          // Assert
          expect(result).toBeUndefined();
        });
      });
    });

    describe('Given "tag" with no trailing space and no LF after it', () => {
      describe('When the verdict is read', () => {
        it('Then it refuses bad tag line', () => {
          // Arrange
          const sut = parseAcceptanceVerdict;
          const scan = scanTag(40, `object ${T(40)}\ntype commit\ntagX`);

          // Act
          const result = sut(scan, CHECKED);

          // Assert
          expect(result).toEqual({ type: 'tag', reason: 'bad tag line' });
        });
      });
    });

    describe('Given "tag " confirmed and a name with no LF anywhere after it', () => {
      describe('When the verdict is read', () => {
        it('Then it refuses bad tag line', () => {
          // Arrange — long enough that the LF search discards a non-empty,
          // still-unresolved carry rather than an already-empty one.
          const sut = parseAcceptanceVerdict;
          const scan = scanTag(40, `object ${T(40)}\ntype commit\ntag good-name-no-newline`);

          // Act
          const result = sut(scan, CHECKED);

          // Assert
          expect(result).toEqual({ type: 'tag', reason: 'bad tag line' });
        });
      });
    });

    describe('Given a third line that misses the tag prefix but does end in an LF', () => {
      describe('When the verdict is read', () => {
        it('Then it refuses bad tag line', () => {
          // Arrange — the LF would carry the scan to its tail, so only the
          // prefix check stands between this body and acceptance.
          const sut = parseAcceptanceVerdict;
          const scan = scanTag(40, `object ${T(40)}\ntype commit\ntagX name\n\nmsg\n`);

          // Act
          const result = sut(scan, CHECKED);

          // Assert
          expect(result).toEqual({ type: 'tag', reason: 'bad tag line' });
        });
      });
    });
  });

  describe('the 64-hex-width object format', () => {
    describe('Given a commit body of exactly h + 6 bytes at h = 64', () => {
      describe('When the verdict is read', () => {
        it('Then it refuses bogus commit object', () => {
          // Arrange
          const sut = parseAcceptanceVerdict;
          const scan = scanCommit(64, `tree ${T(64)}\n`);

          // Act
          const result = sut(scan, CHECKED);

          // Assert
          expect(result).toEqual({ type: 'commit', reason: 'bogus commit object' });
        });
      });
    });

    describe('Given a well-formed commit at h = 64', () => {
      describe('When the verdict is read', () => {
        it('Then it is accepted', () => {
          // Arrange
          const sut = parseAcceptanceVerdict;
          const scan = scanCommit(64, `tree ${T(64)}\nparent ${T(64, 'b')}\n\nmsg\n`);

          // Act
          const result = sut(scan, CHECKED);

          // Assert
          expect(result).toBeUndefined();
        });
      });
    });
  });

  describe('streaming: a body arriving in more than one feed call', () => {
    describe('Given a commit whose tree line arrives split across two chunks', () => {
      describe('When each half is fed in turn', () => {
        it('Then the result is identical to feeding it whole', () => {
          // Arrange — the first chunk stops mid tree-line window, so the
          // scan must wait rather than decide anything yet.
          const body = ENC.encode(`tree ${T(40)}\nparent ${T(40, 'b')}\n\nmsg\n`);
          const first = body.subarray(0, 10);
          const second = body.subarray(10);
          const sut = feedParseAcceptance;

          // Act
          const scan = sut(sut(startParseAcceptance('commit', 40), first), second);

          // Assert
          expect(parseAcceptanceVerdict(scan, CHECKED)).toBeUndefined();
        });
      });
    });

    describe('Given a commit whose parent-line prefix itself arrives split', () => {
      describe('When each half is fed in turn', () => {
        it('Then the result is identical to feeding it whole', () => {
          // Arrange — the first chunk ends 3 bytes into "parent ", too few
          // even to test the 7-byte prefix.
          const body = ENC.encode(`tree ${T(40)}\nparent ${T(40, 'b')}\n\nmsg\n`);
          const first = body.subarray(0, 46 + 3);
          const second = body.subarray(46 + 3);
          const sut = feedParseAcceptance;

          // Act
          const scan = sut(sut(startParseAcceptance('commit', 40), first), second);

          // Assert
          expect(parseAcceptanceVerdict(scan, CHECKED)).toBeUndefined();
        });
      });
    });

    describe('Given a commit whose parent line arrives split before its lookahead byte', () => {
      describe('When each half is fed in turn', () => {
        it('Then a hash-fixed-point-free parent line is still accepted', () => {
          // Arrange — split right after the tree line, so the whole parent
          // line (h + 8 bytes) arrives with nothing left over, forcing the
          // scan to wait for the lookahead byte in a later chunk.
          const treeHex = T(40);
          const body = ENC.encode(`tree ${treeHex}\nparent ${T(40, 'b')}\nx`);
          const first = body.subarray(0, 46 + 48);
          const second = body.subarray(46 + 48);
          const sut = feedParseAcceptance;

          // Act
          const scan = sut(sut(startParseAcceptance('commit', 40), first), second);

          // Assert
          expect(parseAcceptanceVerdict(scan, CHECKED)).toBeUndefined();
        });
      });
    });

    describe('Given a tag whose object line arrives split across two chunks', () => {
      describe('When each half is fed in turn', () => {
        it('Then the result is identical to feeding it whole', () => {
          // Arrange
          const body = ENC.encode(`object ${T(40)}\ntype commit\ntag t\n\nmsg\n`);
          const first = body.subarray(0, 5);
          const second = body.subarray(5);
          const sut = feedParseAcceptance;

          // Act
          const scan = sut(sut(startParseAcceptance('tag', 40), first), second);

          // Assert
          expect(parseAcceptanceVerdict(scan, CHECKED)).toBeUndefined();
        });
      });
    });

    describe('Given a tag whose type-line prefix itself arrives split', () => {
      describe('When each half is fed in turn', () => {
        it('Then the result is identical to feeding it whole', () => {
          // Arrange — the first chunk ends exactly at the object line, too
          // few bytes even to test the 5-byte "type " prefix.
          const body = ENC.encode(`object ${T(40)}\ntype commit\ntag t\n\nmsg\n`);
          const first = body.subarray(0, 40 + 8);
          const second = body.subarray(40 + 8);
          const sut = feedParseAcceptance;

          // Act
          const scan = sut(sut(startParseAcceptance('tag', 40), first), second);

          // Assert
          expect(parseAcceptanceVerdict(scan, CHECKED)).toBeUndefined();
        });
      });
    });

    describe('Given a tag whose tag-line prefix itself arrives split', () => {
      describe('When each half is fed in turn', () => {
        it('Then the result is identical to feeding it whole', () => {
          // Arrange — the first chunk ends exactly at the type line, too few
          // bytes even to test the 4-byte "tag " prefix.
          const body = ENC.encode(`object ${T(40)}\ntype commit\ntag t\n\nmsg\n`);
          const first = body.subarray(0, 40 + 8 + 12);
          const second = body.subarray(40 + 8 + 12);
          const sut = feedParseAcceptance;

          // Act
          const scan = sut(sut(startParseAcceptance('tag', 40), first), second);

          // Assert
          expect(parseAcceptanceVerdict(scan, CHECKED)).toBeUndefined();
        });
      });
    });

    describe('Given a tag whose type name arrives split before its terminating LF', () => {
      describe('When each half is fed in turn', () => {
        it('Then the result is identical to feeding it whole', () => {
          // Arrange — the first chunk ends mid type-name, under the 20-byte
          // cap, so the scan must wait for the LF rather than deciding early.
          const body = ENC.encode(`object ${T(40)}\ntype commit\ntag t\n\nmsg\n`);
          const first = body.subarray(0, 40 + 8 + 8);
          const second = body.subarray(40 + 8 + 8);
          const sut = feedParseAcceptance;

          // Act
          const scan = sut(sut(startParseAcceptance('tag', 40), first), second);

          // Assert
          expect(parseAcceptanceVerdict(scan, CHECKED)).toBeUndefined();
        });
      });
    });
  });

  describe('retained bytes', () => {
    const LONG_BODY_CHUNK_COUNT = 64;
    const LONG_BODY_CHUNK_BYTES = 16 * 1024;
    const LF_FREE_FILLER = 0x78;
    const ONE_PARTIAL_LINE_BYTES = 40 + 8;

    const longBody = (header: string): ReadonlyArray<Uint8Array> => [
      ENC.encode(header),
      ...Array.from({ length: LONG_BODY_CHUNK_COUNT }, () =>
        new Uint8Array(LONG_BODY_CHUNK_BYTES).fill(LF_FREE_FILLER),
      ),
    ];

    const RETENTION_ROWS = [
      {
        label: 'a commit whose headers precede a long message',
        type: 'commit',
        header: `tree ${T(40)}\nparent ${T(40, 'b')}\n\n`,
        expected: undefined,
      },
      {
        label: 'a tag whose headers precede a long message',
        type: 'tag',
        header: `object ${T(40)}\ntype commit\ntag t\n\n`,
        expected: undefined,
      },
      {
        label: 'a tag whose type line never ends',
        type: 'tag',
        header: `object ${T(40)}\ntype `,
        expected: { type: 'tag', reason: 'bad type line' },
      },
      {
        label: 'a tag whose tag line never ends',
        type: 'tag',
        header: `object ${T(40)}\ntype commit\ntag `,
        expected: { type: 'tag', reason: 'bad tag line' },
      },
    ] as const;

    describe('Given a body far longer than one line, fed in 16 KiB chunks', () => {
      describe('When every chunk has been fed', () => {
        it.each(RETENTION_ROWS)(
          'Then at most one partial line stays carried and the verdict holds, for $label',
          ({ type, header, expected }) => {
            // Arrange
            const sut = feedParseAcceptance;
            const chunks = longBody(header);

            // Act
            const scan = chunks.reduce(
              (state, chunk) => sut(state, chunk),
              startParseAcceptance(type, 40),
            );

            // Assert
            expect(scan.carry.length).toBeLessThanOrEqual(ONE_PARTIAL_LINE_BYTES);
            expect(parseAcceptanceVerdict(scan, CHECKED)).toEqual(expected);
          },
        );
      });
    });

    describe('Given a partial line whose chunk the caller overwrites once it has been fed', () => {
      describe('When the next chunk completes the line', () => {
        it('Then the verdict reflects the bytes as they were fed', () => {
          // Arrange
          const body = ENC.encode(`tree ${T(40)}\nparent ${T(40, 'b')}\n\nmsg\n`);
          const first = body.slice(0, 10);
          const second = body.slice(10);
          const sut = feedParseAcceptance;
          const afterFirst = sut(startParseAcceptance('commit', 40), first);
          first.fill(LF_FREE_FILLER);

          // Act
          const scan = sut(afterFirst, second);

          // Assert
          expect(parseAcceptanceVerdict(scan, CHECKED)).toBeUndefined();
        });
      });
    });
  });
});
