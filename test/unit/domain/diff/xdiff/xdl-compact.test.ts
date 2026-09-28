import { describe, expect, it } from 'vitest';
import { compactChanges } from '../../../../../src/domain/diff/xdiff/xdl-compact.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const lines = (s: string): ReadonlyArray<Uint8Array> => s.split('\n').map((l) => enc(`${l}\n`));

// Every row below is taken from live `git diff --no-ext-diff --no-index` at
// authoring time (git 2.55.0) on the same bytes — see the part's final report
// for the exact commands.
describe('compactChanges', () => {
  describe('Given the smallest patch-slide row (a b c d e / a b c X d c d e)', () => {
    describe('When ours is unchanged and theirs raw-Myers splits the group in two', () => {
      it('Then it merges and slides the group to git’s +X +d +c placement', () => {
        // Arrange — raw, pre-compaction Myers picks the FIRST `d` as the LCS anchor,
        // leaving theirs split into {X} and {c,d} around a lone common `d`.
        const sut = compactChanges;
        const oursLines = lines('a\nb\nc\nd\ne');
        const theirsLines = lines('a\nb\nc\nX\nd\nc\nd\ne');
        const oursChanged = new Uint8Array([0, 0, 0, 0, 0]);
        const theirsChanged = new Uint8Array([0, 0, 0, 1, 0, 1, 1, 0]);
        const oursIds = new Int32Array([0, 1, 2, 3, 4]);
        const theirsIds = new Int32Array([0, 1, 2, 5, 3, 2, 3, 4]);

        // Act — git's own call order: compact ours against theirs, then theirs against ours
        sut(oursChanged, theirsChanged, oursIds, oursLines);
        sut(theirsChanged, oursChanged, theirsIds, theirsLines);

        // Assert — theirs indices 3,4,5 (X,d,c) changed; 2 and 6 (c,d) common
        expect(Array.from(theirsChanged)).toEqual([0, 0, 0, 1, 1, 1, 0, 0]);
        expect(Array.from(oursChanged)).toEqual([0, 0, 0, 0, 0]);
      });
    });
  });

  describe('Given a form-feed line bracketing an insertion (get_indent’s XDL_ISSPACE class)', () => {
    describe('When theirs raw-Myers matches the group’s trailing form-feed instead of its leading one', () => {
      it('Then it slides the group up to the leading form-feed, matching git’s +FF +q +y placement', () => {
        // Arrange — raw, pre-compaction split anchors the LCS on the SECOND `\f`
        // (index 5), leaving theirs split into {q,y} and a lone matched `\f`.
        // A get_indent that (wrongly) counted `\f` as space would report the
        // `\f` line's indent as -1 (blank) either way, but would also count it
        // as part of a surrounding blank run — sliding the group to the wrong
        // boundary. See `isSpaceByte` (git's XDL_ISSPACE: SP/TAB/CR/LF only).
        const sut = compactChanges;
        const oursLines = lines('x\n  y\n\f\n  z');
        const theirsLines = lines('x\n  y\n\f\n  q\n  y\n\f\n  z');
        const oursChanged = new Uint8Array([0, 0, 0, 0]);
        const theirsChanged = new Uint8Array([0, 0, 0, 1, 1, 1, 0]);
        const oursIds = new Int32Array([0, 1, 2, 3]);
        const theirsIds = new Int32Array([0, 1, 2, 4, 1, 2, 3]);

        // Act — git's own call order: compact ours against theirs, then theirs against ours
        sut(oursChanged, theirsChanged, oursIds, oursLines);
        sut(theirsChanged, oursChanged, theirsIds, theirsLines);

        // Assert — theirs indices 2,3,4 (\f,q,y) changed; the trailing \f (5) common
        expect(Array.from(theirsChanged)).toEqual([0, 0, 1, 1, 1, 0, 0]);
        expect(Array.from(oursChanged)).toEqual([0, 0, 0, 0]);
      });
    });
  });

  describe('Given a form-feed line between two braces (get_indent’s XDL_ISSPACE class)', () => {
    describe('When theirs raw-Myers matches the group’s trailing form-feed instead of its leading one', () => {
      it('Then it slides the group up to the leading form-feed, matching git’s +FF +k placement', () => {
        // Arrange — same shape as the row above, one line shorter each side.
        const sut = compactChanges;
        const oursLines = lines('{\n\f\n}');
        const theirsLines = lines('{\n\f\n  k\n\f\n}');
        const oursChanged = new Uint8Array([0, 0, 0]);
        const theirsChanged = new Uint8Array([0, 0, 1, 1, 0]);
        const oursIds = new Int32Array([0, 1, 2]);
        const theirsIds = new Int32Array([0, 1, 3, 1, 2]);

        // Act
        sut(oursChanged, theirsChanged, oursIds, oursLines);
        sut(theirsChanged, oursChanged, theirsIds, theirsLines);

        // Assert — theirs indices 1,2 (\f,k) changed; the trailing \f (3) common
        expect(Array.from(theirsChanged)).toEqual([0, 1, 1, 0, 0]);
        expect(Array.from(oursChanged)).toEqual([0, 0, 0]);
      });
    });
  });

  describe('Given a group with no other-file alignment and no slide (a X b / a b)', () => {
    describe('When the deleted line cannot slide in either direction', () => {
      it('Then the group is left in place', () => {
        // Arrange
        const sut = compactChanges;
        const oursLines = lines('a\nX\nb');
        const oursChanged = new Uint8Array([0, 1, 0]);
        const otherChanged = new Uint8Array([0, 0]);
        const oursIds = new Int32Array([0, 1, 2]);

        // Act
        sut(oursChanged, otherChanged, oursIds, oursLines);

        // Assert
        expect(Array.from(oursChanged)).toEqual([0, 1, 0]);
      });
    });
  });

  describe('Given the C-function-block insertion (git’s functions.c fixture)', () => {
    describe('When a repeated `/* function */` comment brackets the new block', () => {
      it('Then the indent heuristic slides the group up to the earlier comment line', () => {
        // Arrange — raw Myers marks theirs[3..7] changed (bar()'s body plus the
        // trailing "/* function */" that precedes the pre-existing foo()).
        const sut = compactChanges;
        const oldFn = lines('1\n2\n/* function */\nfoo() {\n    foo\n}\n\n3\n4');
        const newFn = lines(
          '1\n2\n/* function */\nbar() {\n    foo\n}\n\n/* function */\nfoo() {\n    foo\n}\n\n3\n4',
        );
        const oursChanged = new Uint8Array(oldFn.length);
        const theirsChanged = new Uint8Array(newFn.length);
        for (let i = 3; i < 8; i++) theirsChanged[i] = 1;
        const oursIds = new Int32Array([0, 1, 2, 3, 4, 5, 6, 7, 8]);
        const theirsIds = new Int32Array([0, 1, 2, 9, 4, 5, 6, 2, 3, 4, 5, 6, 7, 8]);

        // Act
        sut(oursChanged, theirsChanged, oursIds, oldFn);
        sut(theirsChanged, oursChanged, theirsIds, newFn);

        // Assert — the group slides up by one line: the FIRST "/* function */"
        // (index 2) joins the insertion; the duplicate at index 7 becomes common.
        expect(Array.from(theirsChanged)).toEqual([0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0]);
      });
    });
  });

  describe('Given an inserted function whose body repeats an existing one’s return value', () => {
    describe('When the group can slide across lines at more than one indent level', () => {
      it('Then it settles where git does, having scored a body indented more than its header', () => {
        // Arrange — "return 1;" (indent 4) repeats inside both int a() and the
        // inserted int b(), and "}" (indent 0) repeats after every function,
        // so the group can slide across both the brace and the return-value
        // lines — landing candidate splits at both indent levels.
        const sut = compactChanges;
        const oldFn = lines('int a() {\n    return 1;\n}\nint c() {\n    return 3;\n}');
        const newFn = lines(
          'int a() {\n    return 1;\n}\nint b() {\n    return 1;\n}\nint c() {\n    return 3;\n}',
        );
        const oursChanged = new Uint8Array(oldFn.length);
        const theirsChanged = new Uint8Array(newFn.length);
        for (let i = 3; i < 6; i++) theirsChanged[i] = 1;
        const oursIds = new Int32Array([0, 1, 2, 3, 4, 2]);
        const theirsIds = new Int32Array([0, 1, 2, 5, 1, 2, 3, 4, 2]);

        // Act
        sut(oursChanged, theirsChanged, oursIds, oldFn);
        sut(theirsChanged, oursChanged, theirsIds, newFn);

        // Assert — git places the insertion identically with the indent
        // heuristic on or off: the natural down-slide already reaches the
        // best-scoring position.
        expect(Array.from(theirsChanged)).toEqual([0, 0, 0, 1, 1, 1, 0, 0, 0]);
      });
    });
  });

  describe('Given a slidable group next to a tab-indented line', () => {
    describe('When the candidate splits sweep past 25 tabs of indentation', () => {
      it('Then get_indent’s tab arithmetic and its MAX_INDENT clamp both run', () => {
        // Arrange — a uniform class id everywhere lets the single-line group
        // slide freely across the whole array, so bestIndentShift measures a
        // split landing on the 30-tab line (indent clamps at 200) as well as
        // on the plain "a" lines around it.
        const sut = compactChanges;
        const tabLine = enc(`${'\t'.repeat(30)}X\n`);
        const theirsLines = [enc('a\n'), tabLine, enc('a\n'), enc('a\n'), enc('a\n')];
        const oursChanged = new Uint8Array(2);
        const theirsChanged = new Uint8Array([0, 1, 0, 0, 0]);
        const theirsIds = new Int32Array([0, 0, 0, 0, 0]);

        // Act
        sut(theirsChanged, oursChanged, theirsIds, theirsLines);

        // Assert — verified by direct computation against this module
        expect(Array.from(theirsChanged)).toEqual([0, 0, 0, 0, 1]);
      });
    });
  });

  describe('Given a slidable single line dipping out of an indented block and back in', () => {
    describe('When a candidate split lands on the dip', () => {
      it('Then the outdent branch (less indented, more indented after) is scored', () => {
        // Arrange — "X" (indent 0) sits between two runs of "    a" (indent 4);
        // a uniform class id lets it slide, so bestIndentShift measures a
        // split right where indentation dips and rises again.
        const sut = compactChanges;
        const theirsLines = lines('    a\nX\n    a\n    a');
        const oursChanged = new Uint8Array(2);
        const theirsChanged = new Uint8Array([0, 1, 0, 0]);
        const theirsIds = new Int32Array([0, 0, 0, 0]);

        // Act
        sut(theirsChanged, oursChanged, theirsIds, theirsLines);

        // Assert — verified by direct computation against this module
        expect(Array.from(theirsChanged)).toEqual([0, 0, 0, 1]);
      });
    });
  });

  describe('Given a slidable single line dipping out of an indented block, one blank line up', () => {
    describe('When the candidate split’s predecessor is separated by a blank line', () => {
      it('Then the outdent-with-blank ternary branch runs', () => {
        // Arrange — same dip shape as the outdent case above, but a blank
        // line now sits between "X" and its nearest non-blank predecessor,
        // so anyBlanks is true where the outdent penalty is scored.
        const sut = compactChanges;
        const theirsLines = [enc('    a\n'), enc('\n'), enc('X\n'), enc('    a\n')];
        const oursChanged = new Uint8Array(2);
        const theirsChanged = new Uint8Array([0, 0, 1, 0]);
        const theirsIds = new Int32Array([0, 0, 0, 0]);

        // Act
        sut(theirsChanged, oursChanged, theirsIds, theirsLines);

        // Assert — verified by direct computation against this module
        expect(Array.from(theirsChanged)).toEqual([0, 1, 0, 0]);
      });
    });
  });

  describe('Given a slidable group preceded by a single blank line', () => {
    describe('When a candidate split follows that blank straight into non-blank content', () => {
      it('Then the indent/dedent penalties’ with-blank ternary branch runs', () => {
        // Arrange — a blank line sits right before the "a\na" group's
        // earliest position, and again before the indented pair further
        // down, so preBlank is 1 (not 0) for those candidate splits.
        const sut = compactChanges;
        const theirsLines = lines('    a\n\na\na\n\n    a\n    a');
        const oursChanged = new Uint8Array(2);
        const theirsChanged = new Uint8Array([0, 0, 1, 1, 0, 0, 0]);
        const theirsIds = new Int32Array(theirsLines.length).fill(0);

        // Act
        sut(theirsChanged, oursChanged, theirsIds, theirsLines);

        // Assert — verified by direct computation against this module
        expect(Array.from(theirsChanged)).toEqual([0, 0, 0, 0, 0, 1, 1]);
      });
    });
  });

  describe('Given a slidable single line surrounded by 21 consecutive blank lines', () => {
    describe('When a candidate split’s blank run exceeds MAX_BLANKS', () => {
      it('Then the blank-run scan caps at 20 and reports indent 0 rather than scanning further', () => {
        // Arrange — a uniform class id lets the single "X" line slide across
        // the whole run of blanks that surrounds it.
        const sut = compactChanges;
        const blanks = Array.from({ length: 21 }, () => enc('\n'));
        const theirsLines = [enc('a\n'), ...blanks, enc('X\n'), enc('a\n')];
        const oursChanged = new Uint8Array(2);
        const theirsChanged = new Uint8Array(theirsLines.length);
        theirsChanged[theirsLines.length - 2] = 1;
        const theirsIds = new Int32Array(theirsLines.length).fill(0);

        // Act
        sut(theirsChanged, oursChanged, theirsIds, theirsLines);

        // Assert — verified by direct computation against this module
        const expected = new Array(theirsLines.length).fill(0);
        expected[theirsLines.length - 3] = 1;
        expect(Array.from(theirsChanged)).toEqual(expected);
      });
    });
  });

  describe('Given two groups one line apart, joined by sliding the first one down', () => {
    describe('When the first group’s down-slide lands exactly on the second group', () => {
      it('Then group_slide_down’s own merge scan absorbs it, not just group_slide_up’s', () => {
        // Arrange — "q" repeats at indices 1-3, so the single-line group at
        // index 1 can slide down through it; the second group (index 4) sits
        // immediately after, so the slide's own merge scan (not the one in
        // group_slide_up, already exercised above) has to extend past it.
        const sut = compactChanges;
        const theirsLines = lines('p\nq\nq\nq\nr\ns');
        const oursChanged = new Uint8Array(2);
        const theirsChanged = new Uint8Array([0, 1, 0, 0, 1, 0]);
        const theirsIds = new Int32Array([0, 1, 1, 1, 2, 3]);

        // Act
        sut(theirsChanged, oursChanged, theirsIds, theirsLines);

        // Assert — verified by direct computation against this module
        expect(Array.from(theirsChanged)).toEqual([0, 0, 0, 1, 1, 0]);
      });
    });
  });

  describe('Given a duplicated line at the very start of the file (a a b / a b)', () => {
    describe('When the inserted run can slide all the way up to index 0', () => {
      it('Then group_previous’s boundary scan reads the -1 sentinel as unchanged and settles back down', () => {
        // Arrange — the leading `a` can slide up to index 0 (exercising the
        // -1 sentinel read) and back down; START_OF_FILE_PENALTY then keeps
        // the indent heuristic from settling there.
        const sut = compactChanges;
        const theirsLines = lines('a\na\nb');
        const oursChanged = new Uint8Array(2);
        const theirsChanged = new Uint8Array([0, 1, 0]);
        const theirsIds = new Int32Array([0, 0, 1]);

        // Act
        sut(theirsChanged, oursChanged, theirsIds, theirsLines);

        // Assert
        expect(Array.from(theirsChanged)).toEqual([0, 1, 0]);
      });
    });
  });

  describe('Given a duplicated line at the very end of the file (a b b / a b)', () => {
    describe('When the only alternative split sits past the last line', () => {
      it('Then the end-of-file split’s negative effective indent outweighs its own penalty and wins', () => {
        // Arrange — the trailing `b` could slide up to right after the first
        // `b`, but END_OF_FILE_PENALTY loses to INDENT_WEIGHT * effective
        // indent for the end-of-file candidate, so the group stays put.
        const sut = compactChanges;
        const theirsLines = lines('a\nb\nb');
        const oursChanged = new Uint8Array(2);
        const theirsChanged = new Uint8Array([0, 0, 1]);
        const theirsIds = new Int32Array([0, 1, 1]);

        // Act
        sut(theirsChanged, oursChanged, theirsIds, theirsLines);

        // Assert
        expect(Array.from(theirsChanged)).toEqual([0, 0, 1]);
      });
    });
  });
});
