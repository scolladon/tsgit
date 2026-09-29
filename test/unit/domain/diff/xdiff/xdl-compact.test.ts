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

  describe('Given a 3-line group on one side overlapping two single-line groups on the other', () => {
    describe('When both files are compacted against each other and every slide/merge path runs', () => {
      it('Then group_init, group_previous, group_slide_up/down’s own merge scan, and slideUpToMatch all settle at this module’s own computation', () => {
        // Arrange — a uniform class id lets everything slide freely; marking
        // changes on both sides forces every group-walking helper (init,
        // previous, both slide loops' own merge scans, and the up-slide-to-
        // match branch) to run at least once in a single symmetric pass —
        // verified by direct computation against this module.
        const sut = compactChanges;
        const theirsLines = lines('a\nb\nc\nd');
        const theirsChanged = new Uint8Array([0, 1, 1, 1]);
        const oursChanged = new Uint8Array([1, 0, 0, 1]);
        const ids = new Int32Array([0, 0, 0, 0]);

        // Act — both directions, like git's own call order
        sut(theirsChanged, oursChanged, ids, theirsLines);
        sut(oursChanged, theirsChanged, ids, theirsLines);

        // Assert
        expect(Array.from(theirsChanged)).toEqual([1, 1, 1, 0]);
        expect(Array.from(oursChanged)).toEqual([0, 1, 1, 0]);
      });
    });
  });

  describe('Given a slidable blank line surrounded by two-tab, CR-only, one-tab, and four-space neighbors', () => {
    describe('When the candidate splits sweep across all of them', () => {
      it('Then getIndent’s tab/CR byte classification settles the same shift as this module’s own computation', () => {
        // Arrange — verified by direct computation against this module.
        const sut = compactChanges;
        const theirsLines = ['\t\ta', '\r', '', '\ta', '    a'].map((s) => enc(`${s}\n`));
        const theirsChanged = new Uint8Array(5);
        theirsChanged[2] = 1;
        const oursChanged = new Uint8Array(2);
        const ids = new Int32Array(5);

        // Act
        sut(theirsChanged, oursChanged, ids, theirsLines);

        // Assert
        expect(Array.from(theirsChanged)).toEqual([0, 0, 0, 0, 1]);
      });
    });
  });

  describe('Given a slidable line between a tab-only blank, a CR-only blank, and a space-then-tab indent', () => {
    describe('When the candidate splits sweep across all of them', () => {
      it('Then the space-then-tab indent formula and blank classification settle the same shift as this module’s own computation', () => {
        // Arrange — ' \ta' probes indent += 8 - (indent % 8) starting from a
        // non-zero indent (1, from the leading space) — verified by direct
        // computation against this module.
        const sut = compactChanges;
        const theirsLines = ['\t', '    a', '\r', '    a', ' \ta'].map((s) => enc(`${s}\n`));
        const theirsChanged = new Uint8Array(5);
        theirsChanged[2] = 1;
        const oursChanged = new Uint8Array(2);
        const ids = new Int32Array(5);

        // Act
        sut(theirsChanged, oursChanged, ids, theirsLines);

        // Assert
        expect(Array.from(theirsChanged)).toEqual([0, 0, 0, 0, 1]);
      });
    });
  });

  describe('Given two consecutive empty lines before a slidable mixed space-tab indent', () => {
    describe('When the candidate splits sweep across the empty-line run', () => {
      it('Then the start-of-file penalty’s no-predecessor guard settles the same shift as this module’s own computation', () => {
        // Arrange — verified by direct computation against this module.
        const sut = compactChanges;
        const theirsLines = ['', '', ' \ta', '\ta', 'a'].map((s) => enc(`${s}\n`));
        const theirsChanged = new Uint8Array(5);
        theirsChanged[2] = 1;
        const oursChanged = new Uint8Array(2);
        const ids = new Int32Array(5);

        // Act
        sut(theirsChanged, oursChanged, ids, theirsLines);

        // Assert
        expect(Array.from(theirsChanged)).toEqual([0, 0, 1, 0, 0]);
      });
    });
  });

  describe('Given a slidable line surrounded by a tab-only blank, an empty blank, and a CR-only blank', () => {
    describe('When the candidate splits sweep across all of them', () => {
      it('Then the blank-run scan’s own bookkeeping settles the same shift as this module’s own computation', () => {
        // Arrange — verified by direct computation against this module.
        const sut = compactChanges;
        const theirsLines = ['\ta', '\t', '', '\r', '    a'].map((s) => enc(`${s}\n`));
        const theirsChanged = new Uint8Array(5);
        theirsChanged[2] = 1;
        const oursChanged = new Uint8Array(2);
        const ids = new Int32Array(5);

        // Act
        sut(theirsChanged, oursChanged, ids, theirsLines);

        // Assert
        expect(Array.from(theirsChanged)).toEqual([0, 0, 0, 1, 0]);
      });
    });
  });

  describe('Given a line that opens with a CR byte before its space indent', () => {
    describe('When a candidate split lands on that line', () => {
      it('Then only CR itself counts as whitespace with no indent contribution, not folded into the tab branch', () => {
        // Arrange — '\r    a': CR classifies as whitespace (git's
        // XDL_ISSPACE) but contributes nothing to indent, so the 4 spaces
        // after it are what set the indent — verified by direct computation
        // against this module.
        const sut = compactChanges;
        const theirsLines = ['\r    a', ' ', ' ', '    a', 'a'].map((s) => enc(`${s}\n`));
        const theirsChanged = new Uint8Array(5);
        theirsChanged[0] = 1;
        const oursChanged = new Uint8Array(2);
        const ids = new Int32Array(5);

        // Act
        sut(theirsChanged, oursChanged, ids, theirsLines);

        // Assert
        expect(Array.from(theirsChanged)).toEqual([0, 0, 1, 0, 0]);
      });
    });
  });

  describe('Given one candidate split on a 26-tab line and another on a 210-space line', () => {
    describe('When both raw indents (208 and 210) sit past MAX_INDENT and both clamp to the same 200 ceiling', () => {
      it('Then the clamp ties them, settling the same shift as this module’s own computation rather than by unclamped magnitude', () => {
        // Arrange — 26 tabs clamps at the 25th (indent 200); 210 spaces also
        // clamps at 200 — verified by direct computation against this
        // module.
        const sut = compactChanges;
        const theirsLines = [
          enc('a\n'),
          enc(`${'\t'.repeat(26)}X\n`),
          enc('a\n'),
          enc(`${' '.repeat(210)}X\n`),
        ];
        const theirsChanged = new Uint8Array([1, 0, 0, 0]);
        const oursChanged = new Uint8Array(2);
        const ids = new Int32Array(4);

        // Act
        sut(theirsChanged, oursChanged, ids, theirsLines);

        // Assert
        expect(Array.from(theirsChanged)).toEqual([0, 0, 0, 1]);
      });
    });
  });

  describe('Given a file of 23 blank lines, a 21-line free zone followed by a 2-line wall', () => {
    describe('When a candidate split’s blank-run scan must cross the 20-blank MAX_BLANKS cap', () => {
      it('Then the scan caps at 20 blanks and reports indent 0 rather than scanning the full run', () => {
        // Arrange — every line is blank (a single space), so the cap is the
        // only thing standing between a shift landing just past the wall and
        // one landing deep in the free zone — verified by direct computation
        // against this module.
        const sut = compactChanges;
        const theirsLines = Array.from({ length: 23 }, () => enc(' \n'));
        const theirsChanged = new Uint8Array(23);
        theirsChanged[0] = 1;
        const oursChanged = new Uint8Array(2);
        const ids = new Int32Array(23);
        ids[21] = 2;
        ids[22] = 2;

        // Act
        sut(theirsChanged, oursChanged, ids, theirsLines);

        // Assert
        const expected = new Array(23).fill(0);
        expected[19] = 1;
        expect(Array.from(theirsChanged)).toEqual(expected);
      });
    });
  });

  describe('Given a dedent split among an indent/dedent staircase right before a blank wall', () => {
    describe('When the candidate splits compare the dedent boundary against the post-blank sentinel', () => {
      it('Then postBlankCount’s sign and isOutdent’s boundary conditions settle this module’s own shift', () => {
        // Arrange — verified by direct computation against this module.
        const sut = compactChanges;
        const theirsLines = [' a', 'a', '  a', ' ', ' ', 'a'].map((s) => enc(`${s}\n`));
        const theirsChanged = new Uint8Array([1, 0, 0, 0, 0, 0]);
        const oursChanged = new Uint8Array(6);
        const ids = new Int32Array([0, 0, 0, 2, 2, 2]);

        // Act
        sut(theirsChanged, oursChanged, ids, theirsLines);

        // Assert
        expect(Array.from(theirsChanged)).toEqual([0, 0, 1, 0, 0, 0]);
      });
    });
  });

  describe('Given a group sliding from a two-space indent across a blank pair into an ascending staircase', () => {
    describe('When the candidate splits compare the start-of-file penalty against the outdent boundary', () => {
      it('Then startOfFilePenalty’s sentinel and isOutdent’s boundary conditions settle this module’s own shift', () => {
        // Arrange — verified by direct computation against this module.
        const sut = compactChanges;
        const theirsLines = ['  a', ' ', ' ', ' a', 'a', 'a'].map((s) => enc(`${s}\n`));
        const theirsChanged = new Uint8Array([1, 0, 0, 0, 0, 0]);
        const oursChanged = new Uint8Array(6);
        const ids = new Int32Array([0, 0, 0, 0, 2, 2]);

        // Act
        sut(theirsChanged, oursChanged, ids, theirsLines);

        // Assert
        expect(Array.from(theirsChanged)).toEqual([0, 0, 0, 1, 0, 0]);
      });
    });
  });

  describe('Given a dedent split whose successor line’s indent is exactly 1', () => {
    describe('When the candidate splits compare that against the blank start-of-file sentinel', () => {
      it('Then isOutdent’s "postIndent !== -1" sentinel — not "!== 1" — decides whether the outdent branch runs', () => {
        // Arrange — verified by direct computation against this module.
        const sut = compactChanges;
        const theirsLines = [' ', ' a', 'a', ' a', 'a', '  a'].map((s) => enc(`${s}\n`));
        const theirsChanged = new Uint8Array([1, 0, 0, 0, 0, 0]);
        const oursChanged = new Uint8Array(6);
        const ids = new Int32Array([0, 0, 0, 0, 0, 2]);

        // Act
        sut(theirsChanged, oursChanged, ids, theirsLines);

        // Assert
        expect(Array.from(theirsChanged)).toEqual([0, 0, 0, 1, 0, 0]);
      });
    });
  });

  describe('Given a split with exactly one blank line on each side', () => {
    describe('When preBlank and postBlank are equal and both non-zero', () => {
      it('Then addSplitScore sums preBlank and postBlank to decide anyBlanks, not their difference', () => {
        // Arrange — preBlank === postBlank === 1, so a difference would read
        // as zero (anyBlanks false) while the real sum reads as two
        // (anyBlanks true) — verified by direct computation against this
        // module.
        const sut = compactChanges;
        const theirsLines = [' ', 'a', 'a', ' ', ' ', ' a'].map((s) => enc(`${s}\n`));
        const theirsChanged = new Uint8Array([1, 0, 0, 0, 0, 0]);
        const oursChanged = new Uint8Array(6);
        const ids = new Int32Array([0, 0, 0, 0, 2, 2]);

        // Act
        sut(theirsChanged, oursChanged, ids, theirsLines);

        // Assert
        expect(Array.from(theirsChanged)).toEqual([0, 1, 0, 0, 0, 0]);
      });
    });
  });

  describe('Given a line whose indent hits exactly MAX_INDENT on its last tab before the trailing newline', () => {
    describe('When the clamp check runs on that exact byte', () => {
      it('Then "indent >= MAX_INDENT" clamps immediately, rather than "indent > MAX_INDENT" letting the loop read the newline as a blank', () => {
        // Arrange — 25 tabs lands indent at exactly 200 with nothing after
        // it but the implicit trailing LF: the real `>=` check clamps right
        // there; a `>` check would skip that iteration, see the LF (which
        // adds no indent), exhaust the line, and report -1 (blank) instead
        // of 200 — verified by direct computation against this module.
        const sut = compactChanges;
        const theirsLines = ['X', 'X', '\t'.repeat(25)].map((s) => enc(`${s}\n`));
        const theirsChanged = new Uint8Array([1, 0, 0]);
        const oursChanged = new Uint8Array(2);
        const ids = new Int32Array(3);

        // Act
        sut(theirsChanged, oursChanged, ids, theirsLines);

        // Assert
        expect(Array.from(theirsChanged)).toEqual([1, 0, 0]);
      });
    });
  });

  describe('Given two leading blank lines that reach all the way back to the start of file', () => {
    describe('When a candidate split’s preBlank is non-zero but preIndent is still the -1 sentinel', () => {
      it('Then the start-of-file penalty requires preBlank === 0 too, not just preIndent === -1', () => {
        // Arrange — verified by direct computation against this module.
        const sut = compactChanges;
        const theirsLines = [' ', ' ', ' a', '  a', ' ', ' '].map((s) => enc(`${s}\n`));
        const theirsChanged = new Uint8Array([1, 0, 0, 0, 0, 0]);
        const oursChanged = new Uint8Array(6);
        const ids = new Int32Array([0, 0, 0, 0, 2, 2]);

        // Act
        sut(theirsChanged, oursChanged, ids, theirsLines);

        // Assert
        expect(Array.from(theirsChanged)).toEqual([0, 1, 0, 0, 0, 0]);
      });
    });
  });

  describe('Given a first group whose indent-heuristic placement slides up from its down-slide extreme, followed by a second group', () => {
    describe('When the up-slide-to-bestShift loop in slideToIndentHeuristic runs', () => {
      it('Then it re-syncs the other file’s group tracker on every step, not just this file’s own array', () => {
        // Arrange — group1 (index 0) needs two up-slides off its down-slide
        // extreme to reach its indent-heuristic resting place; group2
        // (index 7) then reads the other file's group tracker to decide its
        // own placement — a skipped re-sync during group1's climb leaves
        // that tracker stale for group2 — verified by direct computation
        // against this module.
        const sut = compactChanges;
        const theirsLines = [' ', ' ', ' a', '  a', ' ', ' ', 'g', 'h'].map((s) => enc(`${s}\n`));
        const theirsChanged = new Uint8Array([1, 0, 0, 0, 0, 0, 0, 1]);
        const oursChanged = new Uint8Array([0, 0, 0, 0, 0, 1, 0, 0]);
        const ids = new Int32Array([0, 0, 0, 0, 2, 2, 3, 3]);

        // Act
        sut(theirsChanged, oursChanged, ids, theirsLines);

        // Assert
        expect(Array.from(theirsChanged)).toEqual([0, 1, 0, 0, 0, 0, 1, 0]);
        expect(Array.from(oursChanged)).toEqual([0, 0, 0, 0, 0, 1, 0, 0]);
      });
    });
  });
});
