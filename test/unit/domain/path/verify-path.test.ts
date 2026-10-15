import { describe, expect, it } from 'vitest';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import {
  gitPickerValidPrefix,
  isDotGitAlias,
  isDotGitWalkEntry,
  verifyPath,
} from '../../../../src/domain/path/verify-path.js';

// TAB (0x09) is accepted inside a component — verified by the matrix row below.
const TAB = String.fromCharCode(0x09);

// Ignorable HFS codepoints the alias arm strips before re-testing for `.git`.
// U+2060 is the pinned non-ignorable control case.
const ZWNJ = String.fromCodePoint(0x200c);
const ZWJ = String.fromCodePoint(0x200d);
const LRM = String.fromCodePoint(0x200e);
const RLM = String.fromCodePoint(0x200f);
const LRE = String.fromCodePoint(0x202a);
const PDF = String.fromCodePoint(0x202e);
const INHIBIT_ARABIC_FORM_SHAPING = String.fromCodePoint(0x206a);
const BOM = String.fromCodePoint(0xfeff);
const WORD_JOINER = String.fromCodePoint(0x2060);

describe('verifyPath', () => {
  describe("Given a name from git's pinned verify_path matrix", () => {
    describe('When verified against its designated mode', () => {
      it.each([
        // --- traversal / shape arms ---
        {
          label: "'ok/file' accepts",
          path: 'ok/file',
          mode: FILE_MODE.REGULAR,
          expected: undefined,
        },
        {
          label: "'../escape' rejects: dotdot-segment",
          path: '../escape',
          mode: FILE_MODE.REGULAR,
          expected: 'dotdot-segment',
        },
        {
          label: "'a/../b' rejects: dotdot-segment",
          path: 'a/../b',
          mode: FILE_MODE.REGULAR,
          expected: 'dotdot-segment',
        },
        {
          label: "'a/../../b' rejects: dotdot-segment",
          path: 'a/../../b',
          mode: FILE_MODE.REGULAR,
          expected: 'dotdot-segment',
        },
        {
          label: "'..' rejects: dotdot-segment",
          path: '..',
          mode: FILE_MODE.REGULAR,
          expected: 'dotdot-segment',
        },
        {
          label: "'a/..' rejects: dotdot-segment",
          path: 'a/..',
          mode: FILE_MODE.REGULAR,
          expected: 'dotdot-segment',
        },
        {
          label: "'./a' rejects: dot-segment",
          path: './a',
          mode: FILE_MODE.REGULAR,
          expected: 'dot-segment',
        },
        {
          label: "'x/./y' rejects: dot-segment",
          path: 'x/./y',
          mode: FILE_MODE.REGULAR,
          expected: 'dot-segment',
        },
        {
          label: "'a/' (trailing sep) rejects: empty-segment",
          path: 'a/',
          mode: FILE_MODE.REGULAR,
          expected: 'empty-segment',
        },
        {
          label: "'a//b' (doubled sep) rejects: empty-segment",
          path: 'a//b',
          mode: FILE_MODE.REGULAR,
          expected: 'empty-segment',
        },
        {
          label: "'/abs/path' rejects: absolute-path",
          path: '/abs/path',
          mode: FILE_MODE.REGULAR,
          expected: 'absolute-path',
        },

        // --- `.git` alias family ---
        {
          label: "'.git' rejects: dotgit-alias",
          path: '.git',
          mode: FILE_MODE.REGULAR,
          expected: 'dotgit-alias',
        },
        {
          label: "'.git/config' rejects: dotgit-alias",
          path: '.git/config',
          mode: FILE_MODE.REGULAR,
          expected: 'dotgit-alias',
        },
        {
          label: "'.GIT/config' rejects: dotgit-alias",
          path: '.GIT/config',
          mode: FILE_MODE.REGULAR,
          expected: 'dotgit-alias',
        },
        {
          label: "'.Git/config' rejects: dotgit-alias",
          path: '.Git/config',
          mode: FILE_MODE.REGULAR,
          expected: 'dotgit-alias',
        },
        {
          label: "'.git.' rejects: dotgit-alias",
          path: '.git.',
          mode: FILE_MODE.REGULAR,
          expected: 'dotgit-alias',
        },
        {
          label: "'.git ' rejects: dotgit-alias",
          path: '.git ',
          mode: FILE_MODE.REGULAR,
          expected: 'dotgit-alias',
        },
        {
          label: "'.git...' rejects: dotgit-alias",
          path: '.git...',
          mode: FILE_MODE.REGULAR,
          expected: 'dotgit-alias',
        },
        {
          label: "'a/.git/config' rejects: dotgit-alias",
          path: 'a/.git/config',
          mode: FILE_MODE.REGULAR,
          expected: 'dotgit-alias',
        },
        {
          label: "'sub/.git' rejects: dotgit-alias",
          path: 'sub/.git',
          mode: FILE_MODE.REGULAR,
          expected: 'dotgit-alias',
        },

        // --- NTFS `git~1` short-name family ---
        {
          label: "'a/git~1/b' rejects: dotgit-ntfs-alias",
          path: 'a/git~1/b',
          mode: FILE_MODE.REGULAR,
          expected: 'dotgit-ntfs-alias',
        },
        {
          label: "'.git~1/config' accepts (leading dot breaks the NTFS short-name match)",
          path: '.git~1/config',
          mode: FILE_MODE.REGULAR,
          expected: undefined,
        },
        {
          label: "'git~1/config' rejects: dotgit-ntfs-alias",
          path: 'git~1/config',
          mode: FILE_MODE.REGULAR,
          expected: 'dotgit-ntfs-alias',
        },
        {
          label: "'GIT~1/config' rejects: dotgit-ntfs-alias",
          path: 'GIT~1/config',
          mode: FILE_MODE.REGULAR,
          expected: 'dotgit-ntfs-alias',
        },
        {
          label: "'gIt~1' rejects: dotgit-ntfs-alias",
          path: 'gIt~1',
          mode: FILE_MODE.REGULAR,
          expected: 'dotgit-ntfs-alias',
        },
        { label: "'git~2' accepts", path: 'git~2', mode: FILE_MODE.REGULAR, expected: undefined },
        { label: "'git~10' accepts", path: 'git~10', mode: FILE_MODE.REGULAR, expected: undefined },
        { label: "'gi~1' accepts", path: 'gi~1', mode: FILE_MODE.REGULAR, expected: undefined },
        {
          label: "'git~1 ' rejects: dotgit-ntfs-alias",
          path: 'git~1 ',
          mode: FILE_MODE.REGULAR,
          expected: 'dotgit-ntfs-alias',
        },
        {
          label: "'git~1.' rejects: dotgit-ntfs-alias",
          path: 'git~1.',
          mode: FILE_MODE.REGULAR,
          expected: 'dotgit-ntfs-alias',
        },

        // --- NTFS `:` alternate-data-stream family ---
        {
          label: "'.git::$INDEX_ALLOCATION' rejects: dotgit-ntfs-stream",
          path: '.git::$INDEX_ALLOCATION',
          mode: FILE_MODE.REGULAR,
          expected: 'dotgit-ntfs-stream',
        },
        {
          label: "'.git:x' rejects: dotgit-ntfs-stream",
          path: '.git:x',
          mode: FILE_MODE.REGULAR,
          expected: 'dotgit-ntfs-stream',
        },
        {
          label:
            "'git~1:x' rejects: dotgit-ntfs-stream (stream suffix on the NTFS short-name alias)",
          path: 'git~1:x',
          mode: FILE_MODE.REGULAR,
          expected: 'dotgit-ntfs-stream',
        },
        {
          label: "'GIT~1:x' rejects: dotgit-ntfs-stream (case-folded short-name alias + stream)",
          path: 'GIT~1:x',
          mode: FILE_MODE.REGULAR,
          expected: 'dotgit-ntfs-stream',
        },
        {
          label:
            "'git~1:x' rejects at 120000 (symlink) too — the alias scan is mode-independent: dotgit-ntfs-stream",
          path: 'git~1:x',
          mode: FILE_MODE.SYMLINK,
          expected: 'dotgit-ntfs-stream',
        },
        {
          label: "'git~2:x' accepts (non-alias short name keeps a stream suffix harmless)",
          path: 'git~2:x',
          mode: FILE_MODE.REGULAR,
          expected: undefined,
        },

        // --- backslash-split family (feeds the alias scan only) ---
        {
          label: "'.git\\\\config' rejects: dotgit-alias",
          path: '.git\\config',
          mode: FILE_MODE.REGULAR,
          expected: 'dotgit-alias',
        },
        {
          label: "'a\\\\.git\\\\b' rejects: dotgit-alias",
          path: 'a\\.git\\b',
          mode: FILE_MODE.REGULAR,
          expected: 'dotgit-alias',
        },
        {
          label: "'a\\\\b' accepts (bare backslash is not itself a rejection)",
          path: 'a\\b',
          mode: FILE_MODE.REGULAR,
          expected: undefined,
        },

        // --- accepted family: reserved names, whitespace/dot noise, near-aliases ---
        { label: "'nul' accepts", path: 'nul', mode: FILE_MODE.REGULAR, expected: undefined },
        { label: "'con' accepts", path: 'con', mode: FILE_MODE.REGULAR, expected: undefined },
        {
          label: "'aux.txt' accepts",
          path: 'aux.txt',
          mode: FILE_MODE.REGULAR,
          expected: undefined,
        },
        { label: "'x ' accepts", path: 'x ', mode: FILE_MODE.REGULAR, expected: undefined },
        { label: "'x.' accepts", path: 'x.', mode: FILE_MODE.REGULAR, expected: undefined },
        { label: "'dir./x' accepts", path: 'dir./x', mode: FILE_MODE.REGULAR, expected: undefined },
        { label: "'dir /x' accepts", path: 'dir /x', mode: FILE_MODE.REGULAR, expected: undefined },
        {
          label: "'. git' accepts (interior space, not trailing)",
          path: '. git',
          mode: FILE_MODE.REGULAR,
          expected: undefined,
        },
        {
          label: "'.gi t' accepts (interior space, not trailing)",
          path: '.gi t',
          mode: FILE_MODE.REGULAR,
          expected: undefined,
        },
        {
          label: "'.gitmodules' accepts at REGULAR mode",
          path: '.gitmodules',
          mode: FILE_MODE.REGULAR,
          expected: undefined,
        },
        { label: "'dotgit' accepts", path: 'dotgit', mode: FILE_MODE.REGULAR, expected: undefined },
        {
          label: "'a<TAB>b' accepts",
          path: `a${TAB}b`,
          mode: FILE_MODE.REGULAR,
          expected: undefined,
        },

        // --- mode-dependent arm: `.gitmodules` must not be a symlink (CVE-2018-11235) ---
        {
          label: "'.gitmodules' accepts at 100644 (regular)",
          path: '.gitmodules',
          mode: FILE_MODE.REGULAR,
          expected: undefined,
        },
        {
          label: "'.gitmodules' accepts at 160000 (gitlink)",
          path: '.gitmodules',
          mode: FILE_MODE.GITLINK,
          expected: undefined,
        },
        {
          label: "'.gitmodules' rejects at 120000 (symlink): gitmodules-not-regular",
          path: '.gitmodules',
          mode: FILE_MODE.SYMLINK,
          expected: 'gitmodules-not-regular',
        },
        {
          label: "'.gitattributes' accepts at 120000 (symlink) — the mode arm is .gitmodules-only",
          path: '.gitattributes',
          mode: FILE_MODE.SYMLINK,
          expected: undefined,
        },
        {
          label: "'.gitignore' accepts at 120000 (symlink) — the mode arm is .gitmodules-only",
          path: '.gitignore',
          mode: FILE_MODE.SYMLINK,
          expected: undefined,
        },
        {
          label:
            "'.gitmodules/foo' rejects at 120000 (symlink, .gitmodules is a NON-leaf component): gitmodules-not-regular",
          path: '.gitmodules/foo',
          mode: FILE_MODE.SYMLINK,
          expected: 'gitmodules-not-regular',
        },
        {
          label: "'.gitmodules/foo' accepts at 100644 (regular) — the mode arm is symlink-only",
          path: '.gitmodules/foo',
          mode: FILE_MODE.REGULAR,
          expected: undefined,
        },
        {
          label:
            "'a/.gitmodules/foo' rejects at 120000 (symlink, .gitmodules at depth 2): gitmodules-not-regular",
          path: 'a/.gitmodules/foo',
          mode: FILE_MODE.SYMLINK,
          expected: 'gitmodules-not-regular',
        },
        {
          label: "'.gitmodules.txt/foo' accepts at 120000 (near-miss name, not exact .gitmodules)",
          path: '.gitmodules.txt/foo',
          mode: FILE_MODE.SYMLINK,
          expected: undefined,
        },

        // --- .gitmodules alias normalisation: NTFS/HFS widened matrix, pinned
        // against git 2.55 (`update-index --add --cacheinfo 120000,<blob>,<name>`) ---
        {
          label: "'.GITMODULES' rejects at 120000 (case-folded alias): gitmodules-not-regular",
          path: '.GITMODULES',
          mode: FILE_MODE.SYMLINK,
          expected: 'gitmodules-not-regular',
        },
        {
          label: "'.gitmodules.' rejects at 120000 (trailing-dot alias): gitmodules-not-regular",
          path: '.gitmodules.',
          mode: FILE_MODE.SYMLINK,
          expected: 'gitmodules-not-regular',
        },
        {
          label: "'.gitmodules ' rejects at 120000 (trailing-space alias): gitmodules-not-regular",
          path: '.gitmodules ',
          mode: FILE_MODE.SYMLINK,
          expected: 'gitmodules-not-regular',
        },
        {
          label: "'gitmod~1' rejects at 120000 (NTFS short name): gitmodules-not-regular",
          path: 'gitmod~1',
          mode: FILE_MODE.SYMLINK,
          expected: 'gitmodules-not-regular',
        },
        {
          label:
            "'gitmod~4' rejects at 120000 (NTFS short name, upper bound): gitmodules-not-regular",
          path: 'gitmod~4',
          mode: FILE_MODE.SYMLINK,
          expected: 'gitmodules-not-regular',
        },
        {
          label:
            "'gitmod~5' accepts at 120000 (git's NTFS short-name generator never emits ~5+ for this base — not over-rejected)",
          path: 'gitmod~5',
          mode: FILE_MODE.SYMLINK,
          expected: undefined,
        },
        {
          label:
            "'gitmod~0' accepts at 120000 (short-name generator never emits ~0 — lower boundary pinned)",
          path: 'gitmod~0',
          mode: FILE_MODE.SYMLINK,
          expected: undefined,
        },
        {
          label:
            "'gitmod~1:x' rejects at 120000 (stream suffix on the truncated short-name alias): gitmodules-not-regular",
          path: 'gitmod~1:x',
          mode: FILE_MODE.SYMLINK,
          expected: 'gitmodules-not-regular',
        },
        {
          label:
            "'gi7eba~1' rejects at 120000 (NTFS hashed short name, lower bound): gitmodules-not-regular",
          path: 'gi7eba~1',
          mode: FILE_MODE.SYMLINK,
          expected: 'gitmodules-not-regular',
        },
        {
          label: "'gi7eba~4' rejects at 120000 (NTFS hashed short name): gitmodules-not-regular",
          path: 'gi7eba~4',
          mode: FILE_MODE.SYMLINK,
          expected: 'gitmodules-not-regular',
        },
        {
          label:
            "'gi7eba~5' rejects at 120000 (the hashed short name is NOT bounded to 1-4 like the truncated form): gitmodules-not-regular",
          path: 'gi7eba~5',
          mode: FILE_MODE.SYMLINK,
          expected: 'gitmodules-not-regular',
        },
        {
          label:
            "'gi7eba~9' rejects at 120000 (NTFS hashed short name, upper single-digit bound): gitmodules-not-regular",
          path: 'gi7eba~9',
          mode: FILE_MODE.SYMLINK,
          expected: 'gitmodules-not-regular',
        },
        {
          label:
            "'gi7eba~0' accepts at 120000 (hashed generator never emits digit 0 — lower boundary pinned)",
          path: 'gi7eba~0',
          mode: FILE_MODE.SYMLINK,
          expected: undefined,
        },
        {
          label:
            "'gi7eba~10' accepts at 120000 (two-digit tail — the hashed form is single-digit only)",
          path: 'gi7eba~10',
          mode: FILE_MODE.SYMLINK,
          expected: undefined,
        },
        {
          label:
            "'GI7EBA~1' rejects at 120000 (case-folded hashed short name): gitmodules-not-regular",
          path: 'GI7EBA~1',
          mode: FILE_MODE.SYMLINK,
          expected: 'gitmodules-not-regular',
        },
        {
          label:
            "'gI7EBa~3' rejects at 120000 (mixed-case hashed short name): gitmodules-not-regular",
          path: 'gI7EBa~3',
          mode: FILE_MODE.SYMLINK,
          expected: 'gitmodules-not-regular',
        },
        {
          label:
            "'abcdef~1' accepts at 120000 (arbitrary 6-char prefix — the hashed prefix is a hardcoded literal, not a computed check)",
          path: 'abcdef~1',
          mode: FILE_MODE.SYMLINK,
          expected: undefined,
        },
        {
          label:
            "'gi7eba~1:x' rejects at 120000 (stream suffix on the hashed short-name alias): gitmodules-not-regular",
          path: 'gi7eba~1:x',
          mode: FILE_MODE.SYMLINK,
          expected: 'gitmodules-not-regular',
        },
        {
          label:
            "'.gitmod<ZWNJ>ules' rejects at 120000 (HFS ignorable codepoint): gitmodules-not-regular",
          path: `.gitmod${ZWNJ}ules`,
          mode: FILE_MODE.SYMLINK,
          expected: 'gitmodules-not-regular',
        },
        {
          label:
            "'foo<ZWNJ>bar' accepts at 120000 (ignorable codepoint present, but stripped name is not .gitmodules)",
          path: `foo${ZWNJ}bar`,
          mode: FILE_MODE.SYMLINK,
          expected: undefined,
        },
        {
          label:
            "'.gitmodules:$DATA' rejects at 120000 (NTFS alternate data stream): gitmodules-not-regular",
          path: '.gitmodules:$DATA',
          mode: FILE_MODE.SYMLINK,
          expected: 'gitmodules-not-regular',
        },
        {
          label:
            "'sub/.GITMODULES' rejects at 120000 (alias at a non-leaf component): gitmodules-not-regular",
          path: 'sub/.GITMODULES',
          mode: FILE_MODE.SYMLINK,
          expected: 'gitmodules-not-regular',
        },
        {
          label:
            "'.GITMODULES' accepts at 100644 (regular) — the widened alias check is symlink-only",
          path: '.GITMODULES',
          mode: FILE_MODE.REGULAR,
          expected: undefined,
        },
        {
          label: "'..' named as a 160000 gitlink still rejects: dotdot-segment",
          path: '..',
          mode: FILE_MODE.GITLINK,
          expected: 'dotdot-segment',
        },

        // --- HFS ignorable-codepoint scan: `.g<CP>it/config` ---
        {
          label: 'U+200C (ZWNJ) rejects: dotgit-hfs-alias',
          path: `.g${ZWNJ}it/config`,
          mode: FILE_MODE.REGULAR,
          expected: 'dotgit-hfs-alias',
        },
        {
          label: 'U+200D (ZWJ) rejects: dotgit-hfs-alias',
          path: `.g${ZWJ}it/config`,
          mode: FILE_MODE.REGULAR,
          expected: 'dotgit-hfs-alias',
        },
        {
          label: 'U+200E (LRM) rejects: dotgit-hfs-alias',
          path: `.g${LRM}it/config`,
          mode: FILE_MODE.REGULAR,
          expected: 'dotgit-hfs-alias',
        },
        {
          label: 'U+200F (RLM) rejects: dotgit-hfs-alias',
          path: `.g${RLM}it/config`,
          mode: FILE_MODE.REGULAR,
          expected: 'dotgit-hfs-alias',
        },
        {
          label: 'U+202A (LRE) rejects: dotgit-hfs-alias',
          path: `.g${LRE}it/config`,
          mode: FILE_MODE.REGULAR,
          expected: 'dotgit-hfs-alias',
        },
        {
          label: 'U+202E (PDF) rejects: dotgit-hfs-alias',
          path: `.g${PDF}it/config`,
          mode: FILE_MODE.REGULAR,
          expected: 'dotgit-hfs-alias',
        },
        {
          label: 'U+206A (inhibit-Arabic-form-shaping) rejects: dotgit-hfs-alias',
          path: `.g${INHIBIT_ARABIC_FORM_SHAPING}it/config`,
          mode: FILE_MODE.REGULAR,
          expected: 'dotgit-hfs-alias',
        },
        {
          label: 'U+FEFF (BOM) rejects: dotgit-hfs-alias',
          path: `.g${BOM}it/config`,
          mode: FILE_MODE.REGULAR,
          expected: 'dotgit-hfs-alias',
        },
        {
          label: 'U+2060 (word joiner) accepts — NOT in the ignorable set (pinned)',
          path: `.g${WORD_JOINER}it/config`,
          mode: FILE_MODE.REGULAR,
          expected: undefined,
        },
      ])('Then $label', (row) => {
        // Arrange — the pinned matrix row supplies the name and mode
        const { path, mode, expected } = row;

        // Act
        const result = verifyPath(path, mode);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('isDotGitAlias', () => {
  describe('Given a component matching one of the four `.git` alias families', () => {
    describe('When checked', () => {
      it.each([
        { label: 'exact .git', component: '.git', expected: true },
        { label: 'NTFS short name git~1', component: 'git~1', expected: true },
        { label: 'NTFS stream .git:x', component: '.git:x', expected: true },
        { label: `HFS-ignorable .g${ZWNJ}it`, component: `.g${ZWNJ}it`, expected: true },
        { label: 'plain non-alias component', component: 'ok', expected: false },
        {
          label: `HFS non-ignorable .g${WORD_JOINER}it`,
          component: `.g${WORD_JOINER}it`,
          expected: false,
        },
      ])('Then $label resolves to $expected', (row) => {
        // Arrange — the alias-family row supplies the component
        const { component, expected } = row;

        // Act
        const result = isDotGitAlias(component);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given a hostile-path corpus probing the isObviouslyNotAnAlias fast path', () => {
    describe('When checked', () => {
      it.each([
        { label: 'plain ASCII filename', component: 'index.ts', expected: false },
        {
          label: 'uppercase-G filename that is not an alias',
          component: 'Gemfile',
          expected: false,
        },
        {
          label: 'backslash-disguised NTFS stream (abc\\.git)',
          component: 'abc\\.git',
          expected: true,
        },
        {
          label: 'ignorable codepoint at the very FRONT of the component (invisible + .git)',
          component: `${ZWNJ}.git`,
          expected: true,
        },
        {
          label: 'a lone `.` (matchShape territory, not this scan)',
          component: '.',
          expected: false,
        },
        { label: 'empty component', component: '', expected: false },
        { label: 'NTFS short name, uppercase (GIT~1)', component: 'GIT~1', expected: true },
        {
          label: 'non-ASCII component with no alias meaning',
          component: '日本語',
          expected: false,
        },
      ])('Then $label resolves to $expected', ({ component, expected }) => {
        // Arrange + Act
        const result = isDotGitAlias(component);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('isDotGitWalkEntry', () => {
  describe("Given a directory-walk entry name, pinned against git's readdir walk (git 2.55.0, darwin, core.ignorecase=true)", () => {
    describe('When checked', () => {
      it.each([
        { label: 'exact .git', name: '.git', expected: true },
        { label: '.GIT (case-folded, matches core.ignorecase=true)', name: '.GIT', expected: true },
        { label: '.Git (mixed case)', name: '.Git', expected: true },
        {
          label: 'git~1 (NTFS short-name alias) — walked, NOT collapsed',
          name: 'git~1',
          expected: false,
        },
        {
          label: '.git:stream (NTFS ADS alias) — walked, NOT collapsed',
          name: '.git:stream',
          expected: false,
        },
        {
          label: `.g${ZWNJ}it (HFS ignorable-codepoint alias) — walked, NOT collapsed`,
          name: `.g${ZWNJ}it`,
          expected: false,
        },
        {
          label: '.git. (trailing dot) — walked, NOT collapsed',
          name: '.git.',
          expected: false,
        },
        {
          label: '.git  (trailing space) — walked, NOT collapsed',
          name: '.git ',
          expected: false,
        },
        { label: 'plain non-alias name', name: 'ok', expected: false },
      ])('Then $label resolves to $expected', (row) => {
        // Arrange — the pinned row supplies the entry name
        const { name, expected } = row;

        // Act
        const result = isDotGitWalkEntry(name);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('verifyPath on raw path bytes', () => {
  const rawPath = (...parts: (string | readonly number[])[]): Uint8Array =>
    Uint8Array.from(
      parts.flatMap((part) =>
        typeof part === 'string' ? [...new TextEncoder().encode(part)] : [...part],
      ),
    );
  const viewOf = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

  describe("Given a '.git' component whose tail git's UTF-8 picker rejects", () => {
    describe('When verified with the raw bytes', () => {
      it.each([
        { label: '.git\\xff/x', bytes: rawPath('.git', [0xff], '/x') },
        { label: '.git\\xed\\xa0\\x80/x', bytes: rawPath('.git', [0xed, 0xa0, 0x80], '/x') },
        { label: '.git\\xc0\\xaf', bytes: rawPath('.git', [0xc0, 0xaf]) },
        { label: '.git\\xc3/x', bytes: rawPath('.git', [0xc3], '/x') },
        {
          label: '.git\\xf4\\x90\\x80\\x80/x',
          bytes: rawPath('.git', [0xf4, 0x90, 0x80, 0x80], '/x'),
        },
        {
          label: '.g\\xef\\xbb\\xbfit\\xff/x',
          bytes: rawPath('.g', [0xef, 0xbb, 0xbf], 'it', [0xff], '/x'),
        },
        {
          label: '.GiT\\xe2\\x80\\x8c\\xff/x',
          bytes: rawPath('.GiT', [0xe2, 0x80, 0x8c, 0xff], '/x'),
        },
        { label: 'a/.git\\xff/x', bytes: rawPath('a/.git', [0xff], '/x') },
        { label: '.git\\xff', bytes: rawPath('.git', [0xff]) },
        { label: '.git\\xef\\xbf\\xbe/x', bytes: rawPath('.git', [0xef, 0xbf, 0xbe], '/x') },
      ])('Then $label is a dotgit-hfs-alias', ({ bytes }) => {
        // Arrange
        const view = viewOf(bytes);

        // Act
        const result = verifyPath(view, FILE_MODE.REGULAR, bytes);

        // Assert
        expect(result).toBe('dotgit-hfs-alias');
      });
    });

    describe('When verified as a symlink named .gitmodules with such a tail', () => {
      it.each([
        { label: '.gitmodules\\xff', bytes: rawPath('.gitmodules', [0xff]) },
        { label: '.gitmodules\\xef\\xbf\\xbe', bytes: rawPath('.gitmodules', [0xef, 0xbf, 0xbe]) },
      ])('Then $label is gitmodules-not-regular', ({ bytes }) => {
        // Arrange
        const view = viewOf(bytes);

        // Act
        const result = verifyPath(view, FILE_MODE.SYMLINK, bytes);

        // Assert
        expect(result).toBe('gitmodules-not-regular');
      });
    });
  });

  describe('Given a string path with a U+FFFE or U+FFFF tail and no bytes', () => {
    describe('When verified', () => {
      it.each([
        {
          label: '.git\\uFFFE/x',
          path: '.git￾/x',
          mode: FILE_MODE.REGULAR,
          expected: 'dotgit-hfs-alias',
        },
        {
          label: '.git\\uFFFF/x',
          path: '.git￿/x',
          mode: FILE_MODE.REGULAR,
          expected: 'dotgit-hfs-alias',
        },
        {
          label: '.gitmodules\\uFFFE symlink',
          path: '.gitmodules￾',
          mode: FILE_MODE.SYMLINK,
          expected: 'gitmodules-not-regular',
        },
      ])('Then $label is rejected', (row) => {
        // Arrange
        const { path, mode, expected } = row;

        // Act
        const result = verifyPath(path, mode);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given names whose tail is a valid or non-alias sequence', () => {
    describe('When verified with the raw bytes', () => {
      it.each([
        {
          label: '.git\\xef\\xbf\\xbd/x (literal U+FFFD)',
          bytes: rawPath('.git', [0xef, 0xbf, 0xbd], '/x'),
          mode: FILE_MODE.REGULAR,
          expected: undefined,
        },
        {
          label: '.g\\xffit/x',
          bytes: rawPath('.g', [0xff], 'it/x'),
          mode: FILE_MODE.REGULAR,
          expected: undefined,
        },
        {
          label: '.gitmodules\\xff regular',
          bytes: rawPath('.gitmodules', [0xff]),
          mode: FILE_MODE.REGULAR,
          expected: undefined,
        },
        {
          label: '.git\\xe2\\x80\\x8c/x',
          bytes: rawPath('.git', [0xe2, 0x80, 0x8c], '/x'),
          mode: FILE_MODE.REGULAR,
          expected: 'dotgit-hfs-alias',
        },
      ])('Then $label yields $expected', ({ bytes, mode, expected }) => {
        // Arrange
        const view = viewOf(bytes);

        // Act
        const result = verifyPath(view, mode, bytes);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('gitPickerValidPrefix', () => {
  describe("Given byte sequences git's UTF-8 picker accepts or rejects", () => {
    describe('When the valid prefix is measured', () => {
      it.each([
        { label: 'empty', bytes: [], expected: 0 },
        { label: 'ASCII only', bytes: [0x61, 0x62], expected: 2 },
        { label: 'valid 2-byte', bytes: [0xc3, 0xa9], expected: 2 },
        { label: 'valid 3-byte', bytes: [0xe2, 0x80, 0x8c], expected: 3 },
        { label: 'valid 4-byte', bytes: [0xf0, 0x90, 0x80, 0x80], expected: 4 },
        { label: 'U+10FFFF', bytes: [0xf4, 0x8f, 0xbf, 0xbf], expected: 4 },
        { label: 'U+FFFD', bytes: [0xef, 0xbf, 0xbd], expected: 3 },
        { label: 'C0 lead', bytes: [0x61, 0xc0, 0xaf], expected: 1 },
        { label: 'C1 lead', bytes: [0xc1, 0xbf], expected: 0 },
        { label: 'stray continuation', bytes: [0x61, 0x80], expected: 1 },
        { label: 'E0 overlong', bytes: [0xe0, 0x9f, 0xbf], expected: 0 },
        { label: 'surrogate ED A0', bytes: [0xed, 0xa0, 0x80], expected: 0 },
        { label: 'ED 9F is not a surrogate', bytes: [0xed, 0x9f, 0xbf], expected: 3 },
        { label: 'U+FFFE', bytes: [0xef, 0xbf, 0xbe], expected: 0 },
        { label: 'U+FFFF', bytes: [0xef, 0xbf, 0xbf], expected: 0 },
        { label: 'F0 overlong', bytes: [0xf0, 0x8f, 0x80, 0x80], expected: 0 },
        { label: 'F4 beyond Unicode', bytes: [0xf4, 0x90, 0x80, 0x80], expected: 0 },
        { label: 'F5 lead', bytes: [0xf5, 0x80, 0x80, 0x80], expected: 0 },
        { label: 'truncated 3-byte', bytes: [0x61, 0xe2, 0x80], expected: 1 },
        { label: 'bad continuation', bytes: [0xc3, 0x28], expected: 0 },
        { label: 'bad third byte', bytes: [0xe2, 0x80, 0x28], expected: 0 },
      ])('Then $label yields $expected', ({ bytes, expected }) => {
        // Arrange
        const sut = Uint8Array.from(bytes);

        // Act
        const result = gitPickerValidPrefix(sut);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});
