import { describe, expect, it } from 'vitest';
import { TsgitError } from '../../../src/domain/error.js';
import { isDotGitAlias } from '../../../src/domain/path/verify-path.js';
import {
  validateWalkedEntryPath,
  validateWorkingTreePath,
} from '../../../src/domain/working-tree-path.js';

const expectReject = (input: string): TsgitError => {
  let caught: unknown;
  try {
    validateWorkingTreePath(input);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(TsgitError);
  expect((caught as TsgitError).data.code).toBe('PATHSPEC_OUTSIDE_REPO');
  return caught as TsgitError;
};

const expectWalkedEntryReject = (input: string): TsgitError => {
  let caught: unknown;
  try {
    validateWalkedEntryPath(input);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(TsgitError);
  expect((caught as TsgitError).data.code).toBe('PATHSPEC_OUTSIDE_REPO');
  return caught as TsgitError;
};

describe('validateWorkingTreePath', () => {
  describe('Given a plain relative path', () => {
    describe('When validated', () => {
      it('Then returns the branded FilePath', () => {
        // Arrange & Act
        const result = validateWorkingTreePath('a/b.txt');

        // Assert
        expect(result).toBe('a/b.txt');
      });
    });
  });

  describe('Given an empty input', () => {
    describe('When validated', () => {
      it('Then rejects with PATHSPEC_OUTSIDE_REPO carrying the empty input', () => {
        // Arrange & Act
        const err = expectReject('');

        // Assert
        expect((err.data as { path: string }).path).toBe('');
      });
    });
  });

  describe('Given a path containing spaces', () => {
    describe('When validated', () => {
      it('Then accepts it as a valid relative path', () => {
        // Arrange & Act + Assert
        // Kills the StringLiteral mutant on the empty-input guard
        // (`input === ''` -> `input === 'Stryker was here!'`): that string is a
        // legal relative path, so the mutated guard would wrongly reject it.
        expect(validateWorkingTreePath('Stryker was here!')).toBe('Stryker was here!');
      });
    });
  });

  describe('Given a path that exceeds 4096 bytes', () => {
    describe('When validated', () => {
      it('Then rejects', () => {
        // Arrange
        // 'a'.repeat(4097) — single-byte char, byteLength === length.
        const input = 'a'.repeat(4097);

        // Act
        const err = expectReject(input);

        // Assert
        expect((err.data as { path: string }).path).toBe(input);
      });
    });
  });

  describe('Given a path exceeding 4096 bytes but with every component legal', () => {
    describe('When validated', () => {
      it('Then rejects on the total-byte cap', () => {
        // Arrange
        // Kills the L30 `if (byteLength(input) > MAX_PATH_BYTES)` -> `if (false)`
        // mutant. Each component is 200 bytes (≤ 255) so the per-component guard
        // never fires; only the total-byte cap can reject this input.
        const segment = 'a'.repeat(200);
        const input = Array.from({ length: 25 }, () => segment).join('/');
        expect(input.length).toBeGreaterThan(4096);

        // Act
        const err = expectReject(input);

        // Assert
        expect((err.data as { path: string }).path).toBe(input);
      });
    });
  });

  describe('Given a path of exactly 4096 bytes (composed of legal components)', () => {
    describe('When validated', () => {
      it('Then accepts (boundary)', () => {
        // Arrange
        // Kills the `>` → `>=` mutant on the path-byte guard.
        // 16 segments × 254 chars + 15 slashes = 4079. Add '/' + 16 chars
        // → 4096 total, 17 components each ≤ 255 bytes.
        const segment = 'a'.repeat(254);
        const head = Array.from({ length: 16 }, () => segment).join('/');
        const padded = `${head}/${'a'.repeat(16)}`;
        expect(padded.length).toBe(4096);

        // Act + Assert
        expect(validateWorkingTreePath(padded)).toBe(padded);
      });
    });
  });

  describe('Given a leading `/` (absolute path)', () => {
    describe('When validated', () => {
      it('Then rejects', () => {
        // Arrange & Act + Assert
        // Kills the MethodExpression mutant (startsWith → endsWith).
        expectReject('/etc/passwd');
      });
    });
  });

  describe('Given a path ending with `/` (trailing slash)', () => {
    describe('When validated', () => {
      it('Then rejects with empty-component reason (the endsWith mutant would let this through if startsWith→endsWith got applied)', () => {
        // Arrange & Act + Assert — `/etc/passwd` doesn't end with `/` so flipping
        // startsWith→endsWith would accept it. This test pins that the leaf
        // check is on the START, not the END.
        expectReject('foo/');
      });
    });
  });

  describe('Given a backslash in the path', () => {
    describe('When validated', () => {
      it('Then rejects', () => {
        // Arrange & Act + Assert
        expectReject('a\\b');
      });
    });
  });

  describe('Given a NUL byte in the path', () => {
    describe('When validated', () => {
      it('Then rejects', () => {
        // Arrange & Act + Assert
        expectReject('a\0b');
      });
    });
  });

  describe('Given a `.` component', () => {
    describe('When validated', () => {
      it('Then rejects', () => {
        // Arrange & Act + Assert
        expectReject('a/./b');
      });
    });
  });

  describe('Given a `..` component', () => {
    describe('When validated', () => {
      it('Then rejects', () => {
        // Arrange & Act + Assert
        expectReject('a/../b');
      });
    });
  });

  describe('Given a component longer than 255 bytes', () => {
    describe('When validated', () => {
      it('Then rejects', () => {
        // Arrange & Act + Assert
        expectReject(`a/${'b'.repeat(256)}/c`);
      });
    });
  });

  describe('Given a component exactly 255 bytes', () => {
    describe('When validated', () => {
      it('Then accepts (boundary)', () => {
        // Arrange
        const long = 'b'.repeat(255);

        // Act + Assert
        expect(validateWorkingTreePath(`a/${long}/c`)).toBe(`a/${long}/c`);
      });
    });
  });

  describe('Given a leading single-letter drive-letter qualifier (`a:b`)', () => {
    describe('When validated', () => {
      it('Then rejects (drive-letter / pathspec-magic-lookalike guard)', () => {
        // Arrange & Act + Assert
        expectReject('a:b');
      });
    });
  });

  describe('Given a bare leading `:` (pathspec-magic lookalike)', () => {
    describe('When validated', () => {
      it('Then rejects', () => {
        // Arrange & Act + Assert
        expectReject(':foo');
      });
    });
  });

  describe('Given a `:` that is NOT leading (POSIX-legal, git accepts)', () => {
    describe('When validated', () => {
      it.each([
        { label: 'a colon inside the first component', path: 'foo:bar/x' },
        { label: 'a colon inside a nested component', path: 'dir/C:evil' },
      ])('Then $label is accepted, not rejected', ({ path }) => {
        // Arrange & Act + Assert — pinned against git 2.55: `git add` stages
        // both without complaint. The old guard rejected any `:` in any
        // component; only a LEADING `:` is a git-parity/drive-letter hazard.
        expect(validateWorkingTreePath(path)).toBe(path);
      });
    });
  });

  describe('Given a `.git` component (lowercase)', () => {
    describe('When validated', () => {
      it('Then rejects', () => {
        // Arrange & Act + Assert
        expectReject('a/.git/b');
      });
    });
  });

  describe('Given a `.GIT` (uppercase) component', () => {
    describe('When validated', () => {
      it('Then rejects (case-insensitive)', () => {
        // Arrange & Act + Assert
        expectReject('a/.GIT/b');
      });
    });
  });

  describe('Given a `.git ` (trailing space) component', () => {
    describe('When validated', () => {
      it('Then rejects (NTFS hardening)', () => {
        // Arrange & Act + Assert
        expectReject('a/.git /b');
      });
    });
  });

  describe('Given a component containing control byte 0x%s', () => {
    describe('When validated', () => {
      it.each([0x00, 0x01, 0x1f, 0x7f])('Then rejects', (code) => {
        // Arrange
        const input = `a/x${String.fromCharCode(code)}y/c`;

        // Act + Assert
        expectReject(input);
      });
    });
  });

  describe('Given a component with the highest non-control byte 0x20 (space)', () => {
    describe('When validated', () => {
      it('Then accepts', () => {
        // Arrange & Act + Assert
        // Kills the `<= 0x1f` → `<= 0x20` mutant. Space (0x20) is allowed.
        expect(validateWorkingTreePath('a/b c/d')).toBe('a/b c/d');
      });
    });
  });

  describe('Given a component with the boundary control byte 0x1f (unit separator)', () => {
    describe('When validated', () => {
      it('Then rejects', () => {
        // Arrange & Act + Assert
        // Kills the `<= 0x1f` → `< 0x1f` mutant.
        expectReject(`a/b${String.fromCharCode(0x1f)}/c`);
      });
    });
  });

  describe('Given a path with NO `\\\\` and the backslash guard short-circuit', () => {
    describe('When validated', () => {
      it('Then accepts (kills the false-mutant on the backslash check)', () => {
        // Arrange & Act + Assert
        // Direct positive that exercises the `if (input.includes('\\'))` branch
        // via the negative case — accepted path means the conditional was false.
        expect(validateWorkingTreePath('a/b')).toBe('a/b');
      });
    });
  });
});

describe('isDotGitAlias', () => {
  describe('Given the literal ".git"', () => {
    describe('When checked', () => {
      it('Then returns true', () => {
        // Arrange & Act
        const result = isDotGitAlias('.git');

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given an unrelated name', () => {
    describe('When checked', () => {
      it('Then returns false', () => {
        // Arrange & Act
        const result = isDotGitAlias('src');

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given ".git." (trailing dot)', () => {
    describe('When checked', () => {
      it('Then returns true (NTFS variant)', () => {
        // Arrange & Act
        const result = isDotGitAlias('.git.');

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given ".git " (trailing space)', () => {
    describe('When checked', () => {
      it('Then returns true (NTFS variant)', () => {
        // Arrange & Act
        const result = isDotGitAlias('.git ');

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given ".GIT"', () => {
    describe('When checked', () => {
      it('Then returns true (case-insensitive)', () => {
        // Arrange & Act
        const result = isDotGitAlias('.GIT');

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given ".gitignore"', () => {
    describe('When checked', () => {
      it('Then returns false', () => {
        // Arrange & Act
        const result = isDotGitAlias('.gitignore');

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given the NTFS short name "git~1"', () => {
    describe('When checked', () => {
      it('Then returns true', () => {
        // Arrange & Act
        const result = isDotGitAlias('git~1');

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given the NTFS alternate-data-stream form ".git:$INDEX_ALLOCATION"', () => {
    describe('When checked', () => {
      it('Then returns true', () => {
        // Arrange & Act
        const result = isDotGitAlias('.git:$INDEX_ALLOCATION');

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given the HFS+ ignorable-codepoint form ".g<ZWNJ>it"', () => {
    describe('When checked', () => {
      it('Then returns true', () => {
        // Arrange & Act
        const result = isDotGitAlias(`.g${String.fromCodePoint(0x200c)}it`);

        // Assert
        expect(result).toBe(true);
      });
    });
  });
});

describe('validateWorkingTreePath — widened `.git`-alias matrix', () => {
  describe('Given a `git~1` component', () => {
    describe('When validated', () => {
      it('Then rejects (NTFS short-name alias)', () => {
        // Arrange & Act + Assert
        expectReject('a/git~1/b');
      });
    });
  });

  describe('Given a `.git:$INDEX_ALLOCATION` component', () => {
    describe('When validated', () => {
      it('Then rejects via isDotGitAlias (the NTFS-stream alias detection), not the leading-colon guard — the `:` here is not leading', () => {
        // Arrange & Act + Assert
        expectReject('a/.git:$INDEX_ALLOCATION/b');
      });
    });
  });

  describe('Given a `.g<ZWNJ>it` component', () => {
    describe('When validated', () => {
      it('Then rejects (HFS+ ignorable-codepoint alias)', () => {
        // Arrange & Act + Assert
        expectReject(`a/.g${String.fromCodePoint(0x200c)}it/b`);
      });
    });
  });
});

describe('validateWalkedEntryPath', () => {
  describe('Given a plain relative path', () => {
    describe('When validated', () => {
      it('Then returns the branded FilePath', () => {
        // Arrange & Act
        const result = validateWalkedEntryPath('a/b.txt');

        // Assert
        expect(result).toBe('a/b.txt');
      });
    });
  });

  describe("Given a name from git's widened `.git`-alias matrix — accepted here, unlike validateWorkingTreePath", () => {
    describe('When validated', () => {
      it.each([
        { label: 'git~1 (NTFS short-name alias)', path: 'a/git~1/b' },
        {
          label: '.git:$INDEX_ALLOCATION (NTFS alternate-data-stream alias)',
          path: 'a/.git:$INDEX_ALLOCATION/b',
        },
        { label: '.git. (trailing dot)', path: 'a/.git./b' },
        { label: '.git  (trailing space)', path: 'a/.git /b' },
        {
          label: '.g<ZWNJ>it (HFS+ ignorable-codepoint alias)',
          path: `a/.g${String.fromCodePoint(0x200c)}it/b`,
        },
      ])('Then $label is walked as an ordinary path — not rejected', ({ path }) => {
        // Arrange & Act + Assert — this is the narrow-walk boundary's whole
        // point: an on-disk entry shaped like a `.git` alias is not a
        // traversal hazard, so a real `readdir` result must reach the
        // walker's yield, exactly as git's own directory walk does.
        expect(validateWalkedEntryPath(path)).toBe(path);
      });
    });
  });

  describe('Given the empty input', () => {
    describe('When validated', () => {
      it('Then rejects with PATHSPEC_OUTSIDE_REPO carrying the empty input', () => {
        // Arrange & Act
        const err = expectWalkedEntryReject('');

        // Assert
        expect((err.data as { path: string }).path).toBe('');
      });
    });
  });

  describe('Given a path that exceeds 4096 bytes', () => {
    describe('When validated', () => {
      it('Then rejects on the total-byte cap', () => {
        // Arrange
        const input = 'a'.repeat(4097);

        // Act + Assert
        expectWalkedEntryReject(input);
      });
    });
  });

  describe('Given a leading `/` (absolute path)', () => {
    describe('When validated', () => {
      it('Then rejects', () => {
        // Arrange & Act + Assert
        expectWalkedEntryReject('/etc/passwd');
      });
    });
  });

  describe('Given a backslash in the path', () => {
    describe('When validated', () => {
      it('Then rejects', () => {
        // Arrange & Act + Assert
        expectWalkedEntryReject('a\\b');
      });
    });
  });

  describe('Given a NUL byte in the path', () => {
    describe('When validated', () => {
      it('Then rejects', () => {
        // Arrange & Act + Assert
        expectWalkedEntryReject('a\0b');
      });
    });
  });

  describe('Given a `.` component', () => {
    describe('When validated', () => {
      it('Then rejects', () => {
        // Arrange & Act + Assert
        expectWalkedEntryReject('a/./b');
      });
    });
  });

  describe('Given a `..` component', () => {
    describe('When validated', () => {
      it('Then rejects', () => {
        // Arrange & Act + Assert — the exact hazard the walker's
        // defence-in-depth exists for: a malicious adapter returning `..`.
        expectWalkedEntryReject('a/../b');
      });
    });
  });

  describe('Given an empty component (trailing or doubled separator)', () => {
    describe('When validated', () => {
      it('Then rejects', () => {
        // Arrange & Act + Assert
        expectWalkedEntryReject('a//b');
      });
    });
  });

  describe('Given a component longer than 255 bytes', () => {
    describe('When validated', () => {
      it('Then rejects', () => {
        // Arrange & Act + Assert
        expectWalkedEntryReject(`a/${'b'.repeat(256)}/c`);
      });
    });
  });

  describe('Given a component containing control byte 0x%s', () => {
    describe('When validated', () => {
      it.each([0x00, 0x01, 0x1f, 0x7f])('Then rejects', (code) => {
        // Arrange
        const input = `a/x${String.fromCharCode(code)}y/c`;

        // Act + Assert
        expectWalkedEntryReject(input);
      });
    });
  });

  describe('Given a `:` character in a component', () => {
    describe('When validated', () => {
      it('Then accepts — the NTFS ADS/drive-letter guard is a pathspec-input concern, not a walk hazard', () => {
        // Arrange & Act + Assert
        expect(validateWalkedEntryPath('a:b')).toBe('a:b');
      });
    });
  });
});
