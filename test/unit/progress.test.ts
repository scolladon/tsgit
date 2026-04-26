import { describe, expect, it, vi } from 'vitest';

import { consoleProgress, noopProgress, type ProgressReporter } from '../../src/progress.js';

describe('noopProgress', () => {
  it('Given noopProgress, When inspecting it, Then it is frozen', () => {
    // Arrange
    const sut = noopProgress;

    // Assert
    expect(Object.isFrozen(sut)).toBe(true);
  });

  it('Given noopProgress, When start/update/end called with any args, Then they return undefined and never throw', () => {
    // Arrange
    const sut = noopProgress;

    // Assert — covers all three reporter methods.
    expect(sut.start('any-op', 100)).toBeUndefined();
    expect(sut.start('any-op')).toBeUndefined();
    expect(sut.update('any-op', 50, 100, 'text')).toBeUndefined();
    expect(sut.update('any-op', 50)).toBeUndefined();
    expect(sut.end('any-op')).toBeUndefined();
  });

  it('Given noopProgress, When referenced multiple times, Then it is the same singleton instance', () => {
    // Arrange
    const sut = noopProgress;

    // Assert
    expect(noopProgress).toBe(sut);
  });
});

describe('consoleProgress — start', () => {
  it("Given consoleProgress(sink), When start('clone:write-objects', 250), Then sink receives 'clone:write-objects: start/250'", () => {
    // Arrange
    const sink = vi.fn<(line: string) => void>();
    const sut: ProgressReporter = consoleProgress(sink);

    // Act
    sut.start('clone:write-objects', 250);

    // Assert
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith('clone:write-objects: start/250');
  });

  it("Given consoleProgress(sink), When start('clone:discover'), Then sink receives 'clone:discover: start' (no total slash)", () => {
    // Arrange
    const sink = vi.fn<(line: string) => void>();
    const sut: ProgressReporter = consoleProgress(sink);

    // Act
    sut.start('clone:discover');

    // Assert
    expect(sink).toHaveBeenCalledWith('clone:discover: start');
  });
});

describe('consoleProgress — update', () => {
  it("Given consoleProgress(sink), When update('op', 100, 250), Then sink receives 'op: 100/250'", () => {
    // Arrange
    const sink = vi.fn<(line: string) => void>();
    const sut = consoleProgress(sink);

    // Act
    sut.update('op', 100, 250);

    // Assert
    expect(sink).toHaveBeenCalledWith('op: 100/250');
  });

  it("Given consoleProgress(sink), When update('op', 50, undefined, 'progress text'), Then sink receives 'op: 50 progress text'", () => {
    // Arrange
    const sink = vi.fn<(line: string) => void>();
    const sut = consoleProgress(sink);

    // Act
    sut.update('op', 50, undefined, 'progress text');

    // Assert
    expect(sink).toHaveBeenCalledWith('op: 50 progress text');
  });

  it("Given consoleProgress(sink), When update('op', 50), Then sink receives 'op: 50' (no total, no text)", () => {
    // Arrange
    const sink = vi.fn<(line: string) => void>();
    const sut = consoleProgress(sink);

    // Act
    sut.update('op', 50);

    // Assert
    expect(sink).toHaveBeenCalledWith('op: 50');
  });

  it('Given consoleProgress(sink), When update with text containing an ANSI escape, Then sink receives the line WITHOUT the ANSI escape', () => {
    // Arrange
    const sink = vi.fn<(line: string) => void>();
    const sut = consoleProgress(sink);

    // Act
    sut.update('op', 1, 1, 'evil\x1b[31mtext');

    // Assert
    expect(sink).toHaveBeenCalledWith('op: 1/1 eviltext');
  });

  it('Given consoleProgress(sink), When update with text containing HTML special chars, Then sink receives HTML-entity-escaped output', () => {
    // Arrange
    const sink = vi.fn<(line: string) => void>();
    const sut = consoleProgress(sink);

    // Act
    sut.update('op', 1, 1, '<script>alert(1)</script>');

    // Assert
    expect(sink).toHaveBeenCalledWith('op: 1/1 &#60;script&#62;alert(1)&#60;/script&#62;');
  });

  it('Given consoleProgress(sink), When update with text containing a BEL byte (0x07), Then sink receives the line with BEL hex-escaped via sanitize', () => {
    // Arrange
    const sink = vi.fn<(line: string) => void>();
    const sut = consoleProgress(sink);

    // Act
    sut.update('op', 1, 1, 'hello\x07world');

    // Assert
    expect(sink).toHaveBeenCalledWith('op: 1/1 hello\\x07world');
  });

  it('Given consoleProgress(sink), When update text is the empty string, Then sink receives the line WITHOUT the trailing space-text segment', () => {
    // Arrange
    const sink = vi.fn<(line: string) => void>();
    const sut = consoleProgress(sink);

    // Act
    sut.update('op', 5, 10, '');

    // Assert — empty text is treated as absent (no trailing space).
    expect(sink).toHaveBeenCalledWith('op: 5/10');
  });
});

describe('consoleProgress — end', () => {
  it("Given consoleProgress(sink), When end('op'), Then sink receives 'op: done'", () => {
    // Arrange
    const sink = vi.fn<(line: string) => void>();
    const sut = consoleProgress(sink);

    // Act
    sut.end('op');

    // Assert
    expect(sink).toHaveBeenCalledWith('op: done');
  });
});

describe('consoleProgress — op sanitization', () => {
  it('Given consoleProgress(sink), When start receives an op with a control byte, Then the op is sanitized in the formatted line', () => {
    // Arrange
    const sink = vi.fn<(line: string) => void>();
    const sut = consoleProgress(sink);

    // Act — op should never contain control bytes in normal usage; the
    // facade defends defensively against a programming bug that wires a
    // sideband-derived string into the op slot (design §6.1).
    sut.start('evil\x07op');

    // Assert
    expect(sink).toHaveBeenCalledWith('evil\\x07op: start');
  });

  it('Given consoleProgress(sink), When end receives an op with an ANSI escape, Then the escape is stripped', () => {
    // Arrange
    const sink = vi.fn<(line: string) => void>();
    const sut = consoleProgress(sink);

    // Act
    sut.end('a\x1b[31mb');

    // Assert
    expect(sink).toHaveBeenCalledWith('ab: done');
  });
});

describe('consoleProgress — sink robustness', () => {
  it('Given consoleProgress(sink) where sink throws on start, When start runs, Then no exception escapes the reporter', () => {
    // Arrange
    const sink = vi.fn<(line: string) => void>(() => {
      throw new Error('boom');
    });
    const sut = consoleProgress(sink);

    // Act / Assert
    expect(() => sut.start('op')).not.toThrow();
  });

  it('Given consoleProgress(sink) where sink throws on update, When update runs, Then no exception escapes the reporter', () => {
    // Arrange
    const sink = vi.fn<(line: string) => void>(() => {
      throw new Error('boom');
    });
    const sut = consoleProgress(sink);

    // Act / Assert
    expect(() => sut.update('op', 1, 2)).not.toThrow();
  });

  it('Given consoleProgress(sink) where sink throws on end, When end runs, Then no exception escapes the reporter', () => {
    // Arrange
    const sink = vi.fn<(line: string) => void>(() => {
      throw new Error('boom');
    });
    const sut = consoleProgress(sink);

    // Act / Assert
    expect(() => sut.end('op')).not.toThrow();
  });
});
