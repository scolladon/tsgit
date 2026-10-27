import { bytesEqual, concatBytes } from '../objects/encoding.js';
import { splitLines } from './line-diff.js';
import { computeHunks, type OutputHunk } from './patch-serializer.js';

const DIFF_CONTEXT_LINES = 3;

type Lines = ReadonlyArray<Uint8Array>;

interface Sides {
  readonly base: Uint8Array;
  readonly target: Uint8Array;
  readonly current: Uint8Array;
}

interface Fragment {
  readonly pre: Lines;
  readonly post: Lines;
  readonly newStart: number;
  readonly matchBeginning: boolean;
  readonly matchEnd: boolean;
}

const spanOf = (all: Lines, start: number, len: number): Lines => {
  const from = len === 0 ? start : start - 1;
  return all.slice(from, from + len);
};

const trailingContext = (hunk: OutputHunk): number =>
  [...hunk.body].reverse().findIndex((line) => line.kind !== 'context');

const fragmentOf = (hunk: OutputHunk, baseLines: Lines, targetLines: Lines): Fragment => ({
  pre: spanOf(baseLines, hunk.oldStart, hunk.oldLen),
  post: spanOf(targetLines, hunk.newStart, hunk.newLen),
  newStart: hunk.newStart,
  matchBeginning: hunk.oldStart <= 1,
  matchEnd: trailingContext(hunk) === 0,
});

const fitsAt = (image: Lines, fragment: Fragment, at: number): boolean => {
  const end = at + fragment.pre.length;
  if (end > image.length) return false;
  if (fragment.matchBeginning && at !== 0) return false;
  return !fragment.matchEnd || end === image.length;
};

const matchesAt = (image: Lines, fragment: Fragment, at: number): boolean =>
  fitsAt(image, fragment, at) &&
  fragment.pre.every((line, i) => bytesEqual(line, image[at + i] as Uint8Array));

function* candidatesFrom(start: number, length: number): Generator<number> {
  yield start;
  for (let step = 1; step <= length; step++) {
    if (start + step <= length) yield start + step;
    if (start - step >= 0) yield start - step;
  }
}

const findMatch = (image: Lines, fragment: Fragment): number | undefined => {
  const start = Math.min(fragment.newStart > 0 ? fragment.newStart - 1 : 0, image.length);
  for (const at of candidatesFrom(start, image.length)) {
    if (matchesAt(image, fragment, at)) return at;
  }
  return undefined;
};

const splice = (image: Lines, fragment: Fragment, at: number): Lines => [
  ...image.slice(0, at),
  ...fragment.post,
  ...image.slice(at + fragment.pre.length),
];

export const applyDiffOnto = ({ base, target, current }: Sides): Uint8Array | undefined => {
  const baseLines = splitLines(base);
  const targetLines = splitLines(target);
  let image: Lines = splitLines(current);
  for (const hunk of computeHunks(base, target, DIFF_CONTEXT_LINES)) {
    const fragment = fragmentOf(hunk, baseLines, targetLines);
    const at = findMatch(image, fragment);
    if (at === undefined) return undefined;
    image = splice(image, fragment, at);
  }
  return concatBytes(image);
};
