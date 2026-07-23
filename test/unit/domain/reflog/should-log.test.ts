import { describe, expect, it } from 'vitest';
import type { RefName } from '../../../../src/domain/objects/index.js';
import type { LogAllRefUpdates } from '../../../../src/domain/reflog/should-log.js';
import { shouldAutocreateReflog } from '../../../../src/domain/reflog/should-log.js';

const HEAD = 'HEAD' as RefName;
const BRANCH = 'refs/heads/main' as RefName;
const REMOTE = 'refs/remotes/origin/main' as RefName;
const NOTE = 'refs/notes/commits' as RefName;
const TAG = 'refs/tags/v1.0.0' as RefName;

describe('shouldAutocreateReflog', () => {
  describe("logAllRefUpdates: 'always'", () => {
    describe("Given 'always'", () => {
      describe('When checking whether the ref should autocreate a reflog', () => {
        it.each([
          {
            ref: TAG,
            cfg: { logAllRefUpdates: 'always' } as LogAllRefUpdates,
            label: 'a tag logs (every ref logs under always)',
          },
          {
            ref: BRANCH,
            cfg: { logAllRefUpdates: 'always' } as LogAllRefUpdates,
            label: 'a branch logs',
          },
          {
            ref: TAG,
            cfg: { logAllRefUpdates: 'always', bare: true } as LogAllRefUpdates,
            label: 'a tag on a bare repo still logs (always overrides the bare default)',
          },
        ])('Then $label', ({ ref, cfg }) => {
          // Arrange / Act
          const sut = shouldAutocreateReflog(ref, cfg);

          // Assert
          expect(sut).toBe(true);
        });
      });
    });
  });

  describe('logAllRefUpdates: false', () => {
    describe('Given false', () => {
      describe('When checking whether the ref should autocreate a reflog', () => {
        it.each([
          { ref: HEAD, label: 'HEAD does not log' },
          { ref: BRANCH, label: 'a branch does not log' },
        ])('Then $label', ({ ref }) => {
          // Arrange
          const cfg: LogAllRefUpdates = { logAllRefUpdates: false };

          // Act
          const sut = shouldAutocreateReflog(ref, cfg);

          // Assert
          expect(sut).toBe(false);
        });
      });
    });
  });

  describe('logAllRefUpdates: true', () => {
    describe('Given true', () => {
      describe('When checking whether the ref should autocreate a reflog', () => {
        it.each([
          {
            ref: HEAD,
            cfg: { logAllRefUpdates: true } as LogAllRefUpdates,
            expected: true,
            label: 'HEAD logs',
          },
          {
            ref: BRANCH,
            cfg: { logAllRefUpdates: true, bare: true } as LogAllRefUpdates,
            expected: true,
            label: 'a branch on a bare repo still logs (true overrides bare)',
          },
          {
            ref: BRANCH,
            cfg: { logAllRefUpdates: true } as LogAllRefUpdates,
            expected: true,
            label: 'a ref under refs/heads/ logs',
          },
          {
            ref: REMOTE,
            cfg: { logAllRefUpdates: true } as LogAllRefUpdates,
            expected: true,
            label: 'a ref under refs/remotes/ logs',
          },
          {
            ref: NOTE,
            cfg: { logAllRefUpdates: true } as LogAllRefUpdates,
            expected: true,
            label: 'a ref under refs/notes/ logs',
          },
          {
            ref: TAG,
            cfg: { logAllRefUpdates: true } as LogAllRefUpdates,
            expected: false,
            label: 'a tag does not log (tags are not default-loggable)',
          },
          {
            ref: 'FETCH_HEAD' as RefName,
            cfg: { logAllRefUpdates: true } as LogAllRefUpdates,
            expected: false,
            label: 'an unknown pseudo-ref does not log',
          },
        ])('Then $label', ({ ref, cfg, expected }) => {
          // Arrange / Act
          const sut = shouldAutocreateReflog(ref, cfg);

          // Assert
          expect(sut).toBe(expected);
        });
      });
    });
  });

  describe('logAllRefUpdates unset', () => {
    describe('Given a ref and a bare-repo status', () => {
      describe('When checking whether the ref should autocreate a reflog', () => {
        it.each([
          {
            cfg: { bare: false } as LogAllRefUpdates,
            expected: true,
            label: 'a non-bare repo logs',
          },
          {
            cfg: { bare: true } as LogAllRefUpdates,
            expected: false,
            label: 'a bare repo does not log',
          },
          {
            cfg: {} as LogAllRefUpdates,
            expected: true,
            label: 'an empty config logs (bare defaults to false)',
          },
        ])('Then $label', ({ cfg, expected }) => {
          // Arrange / Act
          const sut = shouldAutocreateReflog(BRANCH, cfg);

          // Assert
          expect(sut).toBe(expected);
        });
      });
    });
  });
});
