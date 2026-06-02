/**
 * Reject a display path that would break the line-oriented diff/stat grammar.
 * Tree-entry parsers accept any non-`/`, non-NUL byte sequence as a name, so a
 * crafted tree could carry a path containing `\n`/`\r`/`\0` and smuggle forged
 * lines into a `--stat` or combined-diff stream. Mirrors the patch serializer's
 * `rejectUnsafePathChars` guard; the raw path is never echoed back.
 */
import { invalidDiffInput } from '../diff/index.js';

const CONTROL_CHARS = /[\n\r\0]/;

export const assertSafePath = (path: string): void => {
  if (CONTROL_CHARS.test(path)) {
    throw invalidDiffInput('display path contains a control character');
  }
};
