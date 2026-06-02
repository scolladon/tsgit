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
  let start = 0;
  while (start < lines.length && isBlank(lines[start]!)) start += 1;
  let end = lines.length;
  while (end > start && isBlank(lines[end - 1]!)) end -= 1;
  return lines
    .slice(start, end)
    .map((line) => `${INDENT}${line}`)
    .join('\n');
}
