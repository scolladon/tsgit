import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { profileChildArgs } from '../../profile-child-args.js';

const SCRIPT = '/repo/tooling/profile.ts';

describe('profileChildArgs', () => {
  describe('Given a command to profile, When the child arguments are built', () => {
    it('Then the child loads TypeScript through the transpile hooks with Node’s stripper disabled', () => {
      // Arrange
      const sut = profileChildArgs;

      // Act
      const args = sut(SCRIPT, 'status');

      // Assert
      expect(args).toEqual([
        '--prof',
        '--no-experimental-strip-types',
        '--import',
        expect.stringMatching(/^file:\/\/.*\/tooling\/register-typescript-hooks\.mjs$/),
        SCRIPT,
        '--child',
        'status',
      ]);
    });
  });

  describe('Given the built arguments, When the imported hook registration is resolved', () => {
    it('Then it names a file that exists', () => {
      // Arrange
      const sut = profileChildArgs;

      // Act
      const registration = sut(SCRIPT, 'log')[3] ?? '';

      // Assert
      expect(existsSync(fileURLToPath(registration))).toBe(true);
    });
  });
});
