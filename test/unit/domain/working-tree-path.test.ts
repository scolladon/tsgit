import { describe, expect, it } from 'vitest';
import { TsgitError } from '../../../src/domain/error.js';
import {
  isForbiddenGitComponent,
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

describe('validateWorkingTreePath', () => {
  it('Given a plain relative path, When validated, Then returns the branded FilePath', () => {
    expect(validateWorkingTreePath('a/b.txt')).toBe('a/b.txt');
  });

  it('Given an empty input, When validated, Then rejects with PATHSPEC_OUTSIDE_REPO carrying the empty input', () => {
    // Kills StringLiteral mutant (`input === 'Stryker was here!'`) AND
    // ConditionalExpression mutant (`if (false)`) on the empty-input guard.
    const err = expectReject('');
    expect((err.data as { path: string }).path).toBe('');
  });

  it('Given a path that exceeds 4096 bytes, When validated, Then rejects', () => {
    // 'a'.repeat(4097) — single-byte char, byteLength === length.
    const input = 'a'.repeat(4097);
    const err = expectReject(input);
    expect((err.data as { path: string }).path).toBe(input);
  });

  it('Given a path exceeding 4096 bytes but with every component legal, When validated, Then rejects on the total-byte cap', () => {
    // Kills the L30 `if (byteLength(input) > MAX_PATH_BYTES)` -> `if (false)`
    // mutant. Each component is 200 bytes (≤ 255) so the per-component guard
    // never fires; only the total-byte cap can reject this input.
    const segment = 'a'.repeat(200);
    const input = Array.from({ length: 25 }, () => segment).join('/');
    expect(input.length).toBeGreaterThan(4096);
    const err = expectReject(input);
    expect((err.data as { path: string }).path).toBe(input);
  });

  it('Given a path of exactly 4096 bytes (composed of legal components), When validated, Then accepts (boundary)', () => {
    // Kills the `>` → `>=` mutant on the path-byte guard.
    // 16 segments × 254 chars + 15 slashes = 4079. Add '/' + 16 chars
    // → 4096 total, 17 components each ≤ 255 bytes.
    const segment = 'a'.repeat(254);
    const head = Array.from({ length: 16 }, () => segment).join('/');
    const padded = `${head}/${'a'.repeat(16)}`;
    expect(padded.length).toBe(4096);
    expect(validateWorkingTreePath(padded)).toBe(padded);
  });

  it('Given a leading `/` (absolute path), When validated, Then rejects', () => {
    // Kills the MethodExpression mutant (startsWith → endsWith).
    expectReject('/etc/passwd');
  });

  it('Given a path ending with `/` (trailing slash), When validated, Then rejects with empty-component reason (the endsWith mutant would let this through if startsWith→endsWith got applied)', () => {
    // `/etc/passwd` doesn't end with `/` so flipping startsWith→endsWith
    // would accept it. This test pins that the leaf check is on the
    // START, not the END.
    expectReject('foo/');
  });

  it('Given a backslash in the path, When validated, Then rejects', () => {
    expectReject('a\\b');
  });

  it('Given a NUL byte in the path, When validated, Then rejects', () => {
    expectReject('a\0b');
  });

  it('Given a `.` component, When validated, Then rejects', () => {
    expectReject('a/./b');
  });

  it('Given a `..` component, When validated, Then rejects', () => {
    expectReject('a/../b');
  });

  it('Given a component longer than 255 bytes, When validated, Then rejects', () => {
    expectReject(`a/${'b'.repeat(256)}/c`);
  });

  it('Given a component exactly 255 bytes, When validated, Then accepts (boundary)', () => {
    const long = 'b'.repeat(255);
    expect(validateWorkingTreePath(`a/${long}/c`)).toBe(`a/${long}/c`);
  });

  it('Given a `:` character in a component, When validated, Then rejects (NTFS ADS / drive-letter guard)', () => {
    expectReject('a:b');
  });

  it('Given a `.git` component (lowercase), When validated, Then rejects', () => {
    expectReject('a/.git/b');
  });

  it('Given a `.GIT` (uppercase) component, When validated, Then rejects (case-insensitive)', () => {
    expectReject('a/.GIT/b');
  });

  it('Given a `.git ` (trailing space) component, When validated, Then rejects (NTFS hardening)', () => {
    expectReject('a/.git /b');
  });

  it.each([
    0x00, 0x01, 0x1f, 0x7f,
  ])('Given a component containing control byte 0x%s, When validated, Then rejects', (code) => {
    const input = `a/x${String.fromCharCode(code)}y/c`;
    expectReject(input);
  });

  it('Given a component with the highest non-control byte 0x20 (space), When validated, Then accepts', () => {
    // Kills the `<= 0x1f` → `<= 0x20` mutant. Space (0x20) is allowed.
    expect(validateWorkingTreePath('a/b c/d')).toBe('a/b c/d');
  });

  it('Given a component with the boundary control byte 0x1f (unit separator), When validated, Then rejects', () => {
    // Kills the `<= 0x1f` → `< 0x1f` mutant.
    expectReject(`a/b${String.fromCharCode(0x1f)}/c`);
  });

  it('Given a path with NO `\\` and the backslash guard short-circuit, When validated, Then accepts (kills the false-mutant on the backslash check)', () => {
    // Direct positive that exercises the `if (input.includes('\\'))` branch
    // via the negative case — accepted path means the conditional was false.
    expect(validateWorkingTreePath('a/b')).toBe('a/b');
  });
});

describe('isForbiddenGitComponent', () => {
  it('Given the literal ".git", When checked, Then returns true', () => {
    expect(isForbiddenGitComponent('.git')).toBe(true);
  });

  it('Given an unrelated name, When checked, Then returns false', () => {
    expect(isForbiddenGitComponent('src')).toBe(false);
  });

  it('Given ".git." (trailing dot), When checked, Then returns true (NTFS variant)', () => {
    expect(isForbiddenGitComponent('.git.')).toBe(true);
  });

  it('Given ".git " (trailing space), When checked, Then returns true (NTFS variant)', () => {
    expect(isForbiddenGitComponent('.git ')).toBe(true);
  });

  it('Given ".GIT", When checked, Then returns true (case-insensitive)', () => {
    expect(isForbiddenGitComponent('.GIT')).toBe(true);
  });

  it('Given ".gitignore", When checked, Then returns false', () => {
    expect(isForbiddenGitComponent('.gitignore')).toBe(false);
  });
});
