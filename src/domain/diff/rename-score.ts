import { MAX_SCORE } from './similarity.js';

/** git stops accumulating digits once the scale reaches this, ignoring the rest. */
const SCALE_CAP = 100000;
const DECIMAL = 10;
const PERCENT = 100;

export interface ParsedRenameScore {
  /** The similarity gate on git's 0..MAX_SCORE scale. */
  readonly score: number;
  /** What follows the score — git refuses an option that leaves anything. */
  readonly rest: string;
}

interface Accumulated {
  readonly num: number;
  readonly scale: number;
  readonly dot: boolean;
  readonly end: number;
}

const isDigit = (ch: string | undefined): ch is string =>
  ch !== undefined && ch >= '0' && ch <= '9';

/** The digits (and at most one dot) git reads, stopping before any `%`. */
const accumulate = (text: string): Accumulated => {
  let num = 0;
  let scale = 1;
  let dot = false;
  let at = 0;
  for (; at < text.length; at++) {
    const ch = text[at];
    if (!dot && ch === '.') {
      scale = 1;
      dot = true;
    } else if (isDigit(ch)) {
      if (scale < SCALE_CAP) [scale, num] = [scale * DECIMAL, num * DECIMAL + Number(ch)];
    } else break;
  }
  return { num, scale, dot, end: at };
};

/**
 * git's `parse_rename_score` (`diff.c`): `<n>` reads as a fraction of the
 * next power of ten (`5` is 50%, `077` 7.7%), `<n>%` as a percentage and
 * `0.<n>` as a decimal; a score at or past one is MAX_SCORE.
 */
export const parseRenameScore = (text: string): ParsedRenameScore => {
  const { num, scale: digitScale, dot, end } = accumulate(text);
  const percent = text[end] === '%';
  const scale = percent ? (dot ? digitScale * PERCENT : PERCENT) : digitScale;
  const score = num >= scale ? MAX_SCORE : Math.floor((MAX_SCORE * num) / scale);
  return { score, rest: text.slice(percent ? end + 1 : end) };
};
