/**
 * Lens 3 — a total function over a declared safe subset: a working-tree path whose
 * components are free of control bytes, separators and dot aliases is never refused,
 * whatever the byte length of a component. Lens 1 (round-trip), lens 2 (oracle) and
 * lens 4 (algebraic law) do not fit: validation is not invertible, it has no second
 * implementation to compare against, and no operation composes.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isDotGitAlias } from '../../../src/domain/path/verify-path.js';
import {
  validateWalkedEntryPath,
  validateWorkingTreePath,
  validateWorkingTreePathOn,
} from '../../../src/domain/working-tree-path.js';

const NUM_RUNS = 100;
const FIRST_PRINTABLE = 0x20;
const LAST_BMP_BEFORE_SURROGATES = 0xd7ff;
const SLASH = 0x2f;
const BACKSLASH = 0x5c;
const DELETE = 0x7f;
const MAX_COMPONENT_LENGTH = 600;
const MAX_COMPONENTS = 40;
const DRIVE_PREFIX = /^[A-Za-z]?:/;
const POSIX_HOST = {};

const codeUnit = fc
  .integer({ min: FIRST_PRINTABLE, max: LAST_BMP_BEFORE_SURROGATES })
  .filter((code) => code !== SLASH && code !== BACKSLASH && code !== DELETE);

const component = fc
  .array(codeUnit, { minLength: 1, maxLength: MAX_COMPONENT_LENGTH, size: 'max' })
  .map((codes) => String.fromCharCode(...codes))
  .filter((c) => c !== '.' && c !== '..' && !isDotGitAlias(c));

const workingTreePath = fc
  .array(component, { minLength: 1, maxLength: MAX_COMPONENTS })
  .map((components) => components.join('/'))
  .filter((p) => !DRIVE_PREFIX.test(p));

describe('working-tree path validation properties', () => {
  describe('Given an arbitrary path of control-free components of any byte length', () => {
    describe('When validated', () => {
      it('Then validateWorkingTreePath returns it unchanged', () => {
        // Arrange
        const sut = validateWorkingTreePath;

        // Act + Assert
        fc.assert(
          fc.property(workingTreePath, (p) => {
            expect(sut(p)).toBe(p);
          }),
          { numRuns: NUM_RUNS },
        );
      });

      it('Then validateWalkedEntryPath returns it unchanged', () => {
        // Arrange
        const sut = validateWalkedEntryPath;

        // Act + Assert
        fc.assert(
          fc.property(workingTreePath, (p) => {
            expect(sut(p, POSIX_HOST)).toBe(p);
          }),
          { numRuns: NUM_RUNS },
        );
      });

      it('Then validateWorkingTreePathOn returns it unchanged', () => {
        // Arrange
        const sut = validateWorkingTreePathOn;

        // Act + Assert
        fc.assert(
          fc.property(workingTreePath, (p) => {
            expect(sut(p, POSIX_HOST)).toBe(p);
          }),
          { numRuns: NUM_RUNS },
        );
      });
    });
  });
});
