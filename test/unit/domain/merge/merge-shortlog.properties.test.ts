/**
 * Properties of git's merge shortlog: a local branch head round-trips to its
 * bare name, and the block lists at most `limit` subjects, eliding past it
 * with the total count in the header.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { formatShortlog, shortlogOrigin } from '../../../../src/domain/merge/merge-shortlog.js';

const branchName = fc.stringMatching(/^[a-z][a-z0-9/_-]{0,15}$/);
const subject = fc.stringMatching(/^[a-z][a-z ]{0,10}$/);

describe('merge shortlog properties', () => {
  describe('Given any local branch head description', () => {
    describe('When its origin is taken', () => {
      it('Then it is the bare branch name of a local branch', () => {
        // Arrange
        const sut = shortlogOrigin;

        // Act & Assert
        fc.assert(
          fc.property(branchName, (name) => {
            expect(sut(`branch '${name}' of .`)).toEqual({ name, localBranch: true });
          }),
        );
      });
    });
  });

  describe('Given any branch head of a remote source', () => {
    describe('When its origin is taken', () => {
      it('Then it keeps the quoted name and names the source', () => {
        // Arrange
        const sut = shortlogOrigin;

        // Act & Assert
        fc.assert(
          fc.property(branchName, branchName, (name, host) => {
            const source = `https://${host}`;
            expect(sut(`branch '${name}' of ${source}`)).toEqual({
              name: `'${name}' of ${source}`,
              localBranch: false,
            });
          }),
        );
      });
    });
  });

  describe('Given any walk and limit', () => {
    describe('When formatted', () => {
      it('Then at most limit subjects are listed and an overflow is elided once', () => {
        // Arrange
        const sut = formatShortlog;

        // Act & Assert
        fc.assert(
          fc.property(
            fc.array(subject, { maxLength: 30 }),
            fc.integer({ min: 1, max: 25 }),
            (all, limit) => {
              const subjects = all.slice(0, limit + 1);
              const lines = sut({ name: 'n', count: all.length, subjects }, limit)
                .split('\n')
                .slice(2, -1);
              const overflow = all.length > limit;
              expect(lines).toEqual(
                overflow
                  ? [...all.slice(0, limit).map((s) => `  ${s}`), '  ...']
                  : all.map((s) => `  ${s}`),
              );
            },
          ),
        );
      });
    });
  });
});
