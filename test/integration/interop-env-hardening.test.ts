/**
 * Regression tripwire for the interop spawn env. Proves that `git` spawned
 * through the shared helper reads NO ambient config — neither the developer's
 * global `~/.gitconfig`, nor system `/etc/gitconfig`, nor the XDG config root.
 *
 * Asserts ABSENCE, never a specific leaked value: a leaked value only ever
 * passes on one author's machine, whereas the contract is that nothing leaks.
 * `git config --get <key>` exits 1 with empty stdout when the key resolves
 * nowhere, so the tripwire is "no resolution" for keys a developer commonly
 * sets globally/system-wide.
 */
import { describe, expect, it } from 'vitest';
import { GIT_AVAILABLE, tryRunGit } from './interop-helpers.js';

describe.skipIf(!GIT_AVAILABLE)('interop-env-hardening', () => {
  describe('Given the hardened interop spawn env', () => {
    describe('When probing a key a developer commonly sets in global config', () => {
      it('Then git resolves no value (the global config is not read)', () => {
        // Arrange
        const sut = tryRunGit;

        // Act
        const result = sut(['config', '--get', 'merge.conflictStyle']);

        // Assert
        expect(result.ok).toBe(false);
        expect(result.stdout.trim()).toBe('');
      });
    });

    describe('When probing a key sourced from system config', () => {
      it('Then git resolves no value (the system config is not read)', () => {
        // Arrange
        const sut = tryRunGit;

        // Act
        const result = sut(['config', '--get', 'credential.helper']);

        // Assert
        expect(result.ok).toBe(false);
        expect(result.stdout.trim()).toBe('');
      });
    });
  });
});
