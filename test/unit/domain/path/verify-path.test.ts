import { describe, expect, it } from 'vitest';
import { FILE_MODE } from '../../../../src/domain/objects/file-mode.js';
import {
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
