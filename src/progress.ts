import { sanitize } from './domain/commands/error.js';
import type { ProgressReporter } from './ports/progress-reporter.js';

export type { ProgressReporter };

/** No-op reporter — default when the caller does not provide one. */
export const noopProgress: ProgressReporter = Object.freeze({
  start: () => {},
  update: () => {},
  end: () => {},
});

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ANSI CSI escape sequence (ESC + '[' + params + 'm') is the rule's exact use case; stripping it from sideband text is a deliberate terminal-injection defense.
const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/g;
const HTML_SPECIALS_RE = /[<>&"']/g;

const sanitizeForSink = (text: string): string => {
  // Layer order: ANSI strip first (operates on raw ESC bytes), then sanitize
  // (escapes any remaining non-printable bytes via \xNN), then HTML-entity
  // escape. Stripping must precede sanitize — once sanitize has hex-escaped
  // the ESC byte, the regex can no longer match the sequence as a unit.
  let out = text.replace(ANSI_ESCAPE_RE, '');
  out = sanitize(out);
  out = out.replace(HTML_SPECIALS_RE, (c) => `&#${c.charCodeAt(0)};`);
  return out;
};

/**
 * Built-in reporter that emits one line per call to a user-supplied `sink`.
 *
 * Format:
 *   start(op)             → "<safeOp>: start"
 *   start(op, total)      → "<safeOp>: start/<total>"
 *   update(op, c)         → "<safeOp>: <c>"
 *   update(op, c, t)      → "<safeOp>: <c>/<t>"
 *   update(op, c, t, txt) → "<safeOp>: <c>/<t> <safeText>"
 *   end(op)               → "<safeOp>: done"
 *
 * `op` is sanitized identically to `text` (defense-in-depth: a programming bug
 * that wires a sideband-derived string into `op` cannot inject control characters).
 *
 * A throwing `sink` cannot crash the reporter — every call is wrapped in
 * try/catch.
 */
export const consoleProgress = (sink: (line: string) => void): ProgressReporter => {
  const safeSink = (line: string): void => {
    try {
      sink(line);
    } catch {
      // swallow — reporters must not throw; a faulty sink is the caller's problem
    }
  };
  const formatStart = (op: string, total?: number): string =>
    `${sanitizeForSink(op)}: start${total !== undefined ? `/${total}` : ''}`;
  const formatUpdate = (op: string, current: number, total?: number, text?: string): string => {
    const head = `${sanitizeForSink(op)}: ${current}${total !== undefined ? `/${total}` : ''}`;
    return text !== undefined && text !== '' ? `${head} ${sanitizeForSink(text)}` : head;
  };
  const formatEnd = (op: string): string => `${sanitizeForSink(op)}: done`;
  return {
    start: (op, total) => safeSink(formatStart(op, total)),
    update: (op, current, total, text) => safeSink(formatUpdate(op, current, total, text)),
    end: (op) => safeSink(formatEnd(op)),
  };
};
