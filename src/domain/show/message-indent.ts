/**
 * Indent a commit message the way `git show` / `git log` does: every line is
 * prefixed with four spaces (interior blank lines included), with leading and
 * trailing blank (whitespace-only) lines stripped. Returns the block without
 * any surrounding separator — the caller frames it with blank lines.
 */

const INDENT = '    ';
const isBlank = (line: string): boolean => /^\s*$/.test(line);

export function indentMessage(message: string): string {
  const lines = message.split('\n');
  const first = lines.findIndex((line) => !isBlank(line));
  if (first === -1) return '';
  // Index of the last non-blank line, found from the end (no manual bounds loop).
  const lastFromEnd = [...lines].reverse().findIndex((line) => !isBlank(line));
  return lines
    .slice(first, lines.length - lastFromEnd)
    .map((line) => `${INDENT}${line}`)
    .join('\n');
}
