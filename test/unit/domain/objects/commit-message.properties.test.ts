import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  foldSubject,
  stripspace,
  subjectLine,
} from '../../../../src/domain/objects/commit-message.js';
import { arbCommitMessage, arbNonBlankLine } from './arbitraries.js';

const TRAILING_ASCII_WHITESPACE = /[ \t\v\f\r]$/;

describe('stripspace properties', () => {
  describe('Given an arbitrary commit message, When stripspace runs twice', () => {
    it('Then the second pass is a no-op (idempotent)', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbCommitMessage(), (message) => {
          const once = stripspace(message);
          expect(stripspace(once)).toBe(once);
        }),
        { numRuns: 200 },
      );
    });
  });

  describe('Given an arbitrary commit message, When stripspace runs', () => {
    it('Then the result is empty or a single-newline-terminated, blank-normalized body', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbCommitMessage(), (message) => {
          const result = stripspace(message);
          if (result === '') return;
          // Ends with exactly one trailing newline.
          expect(result.endsWith('\n')).toBe(true);
          expect(result.endsWith('\n\n')).toBe(false);
          // No leading blank line.
          expect(result.startsWith('\n')).toBe(false);
          // No run of two or more consecutive blank lines.
          expect(result.includes('\n\n\n')).toBe(false);
          // No line carries trailing ASCII whitespace.
          for (const line of result.split('\n')) {
            expect(TRAILING_ASCII_WHITESPACE.test(line)).toBe(false);
          }
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('Given an arbitrary commit message, When stripspace runs', () => {
    it('Then it never throws', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbCommitMessage(), (message) => {
          expect(() => stripspace(message)).not.toThrow();
        }),
        { numRuns: 100 },
      );
    });
  });
});

describe('subjectLine properties', () => {
  describe('Given an arbitrary commit message, When subjectLine runs twice', () => {
    it('Then the second pass is a no-op (idempotent)', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbCommitMessage(), (message) => {
          const once = subjectLine(message);
          expect(subjectLine(once)).toBe(once);
        }),
        { numRuns: 200 },
      );
    });
  });

  describe('Given an arbitrary commit message, When subjectLine runs', () => {
    it('Then the result never contains a newline', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbCommitMessage(), (message) => {
          expect(subjectLine(message).includes('\n')).toBe(false);
        }),
        { numRuns: 200 },
      );
    });
  });

  describe('Given an arbitrary commit message, When subjectLine runs', () => {
    it('Then the result is a prefix of the message', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbCommitMessage(), (message) => {
          expect(message.startsWith(subjectLine(message))).toBe(true);
        }),
        { numRuns: 200 },
      );
    });
  });

  describe('Given an arbitrary newline-free message, When subjectLine runs', () => {
    it('Then the message is returned verbatim', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(
          fc.string().filter((s) => !s.includes('\n')),
          (message) => {
            expect(subjectLine(message)).toBe(message);
          },
        ),
        { numRuns: 200 },
      );
    });
  });
});

describe('foldSubject properties', () => {
  describe('Given an arbitrary commit message, When foldSubject runs twice', () => {
    it('Then the second pass is a no-op (idempotent)', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbCommitMessage(), (message) => {
          const once = foldSubject(message);
          expect(foldSubject(once)).toBe(once);
        }),
        { numRuns: 200 },
      );
    });
  });

  describe('Given an arbitrary commit message, When foldSubject runs', () => {
    it('Then the result never contains a newline', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbCommitMessage(), (message) => {
          expect(foldSubject(message).includes('\n')).toBe(false);
        }),
        { numRuns: 200 },
      );
    });
  });

  describe('Given a non-blank subject and an arbitrary body, When foldSubject runs', () => {
    it('Then everything past the first blank line is ignored', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbNonBlankLine(), arbCommitMessage(), (subject, body) => {
          expect(foldSubject(`${subject}\n\n${body}`)).toBe(foldSubject(subject));
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('Given an arbitrary commit message, When foldSubject runs', () => {
    it('Then it never throws', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbCommitMessage(), (message) => {
          expect(() => foldSubject(message)).not.toThrow();
        }),
        { numRuns: 100 },
      );
    });
  });
});
