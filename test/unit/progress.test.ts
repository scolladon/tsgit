import { describe, expect, it, vi } from 'vitest';

import { consoleProgress, noopProgress, type ProgressReporter } from '../../src/progress.js';

describe('noopProgress', () => {
  describe('Given noopProgress', () => {
    describe('When inspecting it', () => {
      it('Then it is frozen', () => {
        // Arrange
        const sut = noopProgress;

        // Assert
        expect(Object.isFrozen(sut)).toBe(true);
      });
    });
    describe('When start/update/end called with any args', () => {
      it('Then they return undefined and never throw', () => {
        // Arrange
        const sut = noopProgress;

        // Assert — covers all three reporter methods.
        expect(sut.start('any-op', 100)).toBeUndefined();
        expect(sut.start('any-op')).toBeUndefined();
        expect(sut.update('any-op', 50, 100, 'text')).toBeUndefined();
        expect(sut.update('any-op', 50)).toBeUndefined();
        expect(sut.end('any-op')).toBeUndefined();
      });
    });
    describe('When referenced multiple times', () => {
      it('Then it is the same singleton instance', () => {
        // Arrange
        const sut = noopProgress;

        // Assert
        expect(noopProgress).toBe(sut);
      });
    });
  });
});

describe('consoleProgress — start', () => {
  describe('Given consoleProgress(sink)', () => {
    describe("When start('clone:write-objects', 250)", () => {
      it("Then sink receives 'clone:write-objects: start/250'", () => {
        // Arrange
        const sink = vi.fn<(line: string) => void>();
        const sut: ProgressReporter = consoleProgress(sink);

        // Act
        sut.start('clone:write-objects', 250);

        // Assert
        expect(sink).toHaveBeenCalledTimes(1);
        expect(sink).toHaveBeenCalledWith('clone:write-objects: start/250');
      });
    });
    describe("When start('clone:discover')", () => {
      it("Then sink receives 'clone:discover: start' (no total slash)", () => {
        // Arrange
        const sink = vi.fn<(line: string) => void>();
        const sut: ProgressReporter = consoleProgress(sink);

        // Act
        sut.start('clone:discover');

        // Assert
        expect(sink).toHaveBeenCalledWith('clone:discover: start');
      });
    });
  });
});

describe('consoleProgress — update', () => {
  describe('Given consoleProgress(sink)', () => {
    describe('When update is called', () => {
      it.each([
        {
          current: 100,
          total: 250,
          text: undefined,
          expected: 'op: 100/250',
          label: "update('op', 100, 250) → sink receives 'op: 100/250'",
        },
        {
          current: 50,
          total: undefined,
          text: 'progress text',
          expected: 'op: 50 progress text',
          label:
            "update('op', 50, undefined, 'progress text') → sink receives 'op: 50 progress text'",
        },
        {
          current: 50,
          total: undefined,
          text: undefined,
          expected: 'op: 50',
          label: "update('op', 50) → sink receives 'op: 50' (no total, no text)",
        },
        {
          current: 1,
          total: 1,
          text: 'evil\x1b[31mtext',
          expected: 'op: 1/1 eviltext',
          label: 'text containing an ANSI escape → sink receives the line WITHOUT the ANSI escape',
        },
        {
          current: 1,
          total: 1,
          text: '<script>alert(1)</script>',
          expected: 'op: 1/1 &#60;script&#62;alert(1)&#60;/script&#62;',
          label: 'text containing HTML special chars → sink receives HTML-entity-escaped output',
        },
        {
          current: 1,
          total: 1,
          text: 'hello\x07world',
          expected: 'op: 1/1 hello\\x07world',
          label:
            'text containing a BEL byte (0x07) → sink receives the line with BEL hex-escaped via sanitize',
        },
        {
          current: 5,
          total: 10,
          text: '',
          expected: 'op: 5/10',
          label:
            'update text is the empty string → sink receives the line WITHOUT the trailing space-text segment',
        },
      ])('Then $label', ({ current, total, text, expected }) => {
        // Arrange
        const sink = vi.fn<(line: string) => void>();
        const sut = consoleProgress(sink);

        // Act
        sut.update('op', current, total, text);

        // Assert
        expect(sink).toHaveBeenCalledWith(expected);
      });
    });
  });
});

describe('consoleProgress — end', () => {
  describe('Given consoleProgress(sink)', () => {
    describe("When end('op')", () => {
      it("Then sink receives 'op: done'", () => {
        // Arrange
        const sink = vi.fn<(line: string) => void>();
        const sut = consoleProgress(sink);

        // Act
        sut.end('op');

        // Assert
        expect(sink).toHaveBeenCalledWith('op: done');
      });
    });
  });
});

describe('consoleProgress — op sanitization', () => {
  describe('Given consoleProgress(sink)', () => {
    describe('When start receives an op with a control byte', () => {
      it('Then the op is sanitized in the formatted line', () => {
        // Arrange
        const sink = vi.fn<(line: string) => void>();
        const sut = consoleProgress(sink);

        // Act — op should never contain control bytes in normal usage; the
        // facade defends defensively against a programming bug that wires a
        // sideband-derived string into the op slot.
        sut.start('evil\x07op');

        // Assert
        expect(sink).toHaveBeenCalledWith('evil\\x07op: start');
      });
    });
    describe('When end receives an op with an ANSI escape', () => {
      it('Then the escape is stripped', () => {
        // Arrange
        const sink = vi.fn<(line: string) => void>();
        const sut = consoleProgress(sink);

        // Act
        sut.end('a\x1b[31mb');

        // Assert
        expect(sink).toHaveBeenCalledWith('ab: done');
      });
    });
  });
});

describe('consoleProgress — sink robustness', () => {
  describe('Given consoleProgress(sink) where sink throws on start', () => {
    describe('When start runs', () => {
      it('Then no exception escapes the reporter', () => {
        // Arrange
        const sink = vi.fn<(line: string) => void>(() => {
          throw new Error('boom');
        });
        const sut = consoleProgress(sink);

        // Act / Assert
        expect(() => sut.start('op')).not.toThrow();
      });
    });
  });

  describe('Given consoleProgress(sink) where sink throws on update', () => {
    describe('When update runs', () => {
      it('Then no exception escapes the reporter', () => {
        // Arrange
        const sink = vi.fn<(line: string) => void>(() => {
          throw new Error('boom');
        });
        const sut = consoleProgress(sink);

        // Act / Assert
        expect(() => sut.update('op', 1, 2)).not.toThrow();
      });
    });
  });

  describe('Given consoleProgress(sink) where sink throws on end', () => {
    describe('When end runs', () => {
      it('Then no exception escapes the reporter', () => {
        // Arrange
        const sink = vi.fn<(line: string) => void>(() => {
          throw new Error('boom');
        });
        const sut = consoleProgress(sink);

        // Act / Assert
        expect(() => sut.end('op')).not.toThrow();
      });
    });
  });
});
