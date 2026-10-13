import type { FilePath } from '../objects/object-id.js';
import { type CrlfAction, type EolSettings, outputLineEnding } from './crlf-action.js';
import { gatherTextStats, isBinaryText, type TextStats } from './text-stats.js';

const CR = 0x0d;
const LF = 0x0a;

export type RoundTripLoss = 'crlf-to-lf' | 'lf-to-crlf';

export interface CrlfToGitInput {
  readonly bytes: Uint8Array;
  readonly action: CrlfAction;
  readonly settings: EolSettings;
  readonly renormalize: boolean;
  /** Read lazily: only an `auto*` action with CRLF present consults the index blob. */
  readonly indexHasCrlf: () => Promise<boolean>;
}

export interface LineEndingLoss {
  readonly loss: RoundTripLoss;
  readonly crlf: number;
  readonly loneLf: number;
}

export interface EolRoundTrip extends LineEndingLoss {
  readonly path: FilePath;
}

export type EolNotice = EolRoundTrip;

export interface CrlfToGitResult {
  readonly bytes: Uint8Array;
  readonly roundTrip?: LineEndingLoss;
}

const isAuto = (action: CrlfAction): boolean => action.startsWith('auto');

const isDroppedCr = (bytes: Uint8Array, index: number, dropEveryCr: boolean): boolean =>
  bytes[index] === CR && (dropEveryCr || bytes[index + 1] === LF);

const stripCr = (bytes: Uint8Array, dropEveryCr: boolean): Uint8Array => {
  let dropped = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (isDroppedCr(bytes, i, dropEveryCr)) dropped++;
  }
  const kept = new Uint8Array(bytes.length - dropped);
  let length = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (!isDroppedCr(bytes, i, dropEveryCr)) kept[length++] = bytes[i] as number;
  }
  return kept;
};

const willConvertLfToCrlf = (
  stats: TextStats,
  action: CrlfAction,
  settings: EolSettings,
): boolean => {
  if (outputLineEnding(action, settings) !== 'crlf' || stats.loneLf === 0) return false;
  if (!isAuto(action)) return true;
  return stats.crlf === 0 && !isBinaryText(stats);
};

const withLoneLfAsCrlf = (stats: TextStats): TextStats => ({
  ...stats,
  // Stryker disable next-line ArithmeticOperator: equivalent — stats.crlf is 0 whenever this runs and loneLf > 0, so +/- both give a nonzero crlf and only `=== 0` reads it
  crlf: stats.crlf + stats.loneLf,
  loneLf: 0,
});

const simulateRoundTrip = (
  stats: TextStats,
  convert: boolean,
  action: CrlfAction,
  settings: EolSettings,
): LineEndingLoss | undefined => {
  const added = convert ? { ...stats, loneLf: stats.loneLf + stats.crlf, crlf: 0 } : stats;
  const checkedOut = willConvertLfToCrlf(added, action, settings) ? withLoneLfAsCrlf(added) : added;
  const counts = { crlf: stats.crlf, loneLf: stats.loneLf };
  if (stats.crlf > 0 && checkedOut.crlf === 0) return { loss: 'crlf-to-lf', ...counts };
  if (stats.loneLf > 0 && checkedOut.loneLf === 0) return { loss: 'lf-to-crlf', ...counts };
  return undefined;
};

const keepsIndexCrlf = async (input: CrlfToGitInput): Promise<boolean> =>
  isAuto(input.action) && !input.renormalize && (await input.indexHasCrlf());

export const crlfToGit = async (input: CrlfToGitInput): Promise<CrlfToGitResult> => {
  const { bytes, action, settings } = input;
  if (action === 'binary') return { bytes };
  const stats = gatherTextStats(bytes);
  if (isAuto(action) && isBinaryText(stats)) return { bytes };
  const convert = stats.crlf > 0 && !(await keepsIndexCrlf(input));
  const roundTrip = simulateRoundTrip(stats, convert, action, settings);
  const converted = convert ? stripCr(bytes, isAuto(action)) : bytes;
  return roundTrip === undefined ? { bytes: converted } : { bytes: converted, roundTrip };
};

const insertCr = (bytes: Uint8Array): Uint8Array => {
  let insertions = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === LF && bytes[i - 1] !== CR) insertions++;
  }
  const expanded = new Uint8Array(bytes.length + insertions);
  let length = 0;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i] as number;
    if (byte === LF && bytes[i - 1] !== CR) expanded[length++] = CR;
    expanded[length++] = byte;
  }
  return expanded;
};

export const crlfToWorkingTree = (
  bytes: Uint8Array,
  action: CrlfAction,
  settings: EolSettings,
): Uint8Array => {
  if (outputLineEnding(action, settings) !== 'crlf') return bytes;
  return willConvertLfToCrlf(gatherTextStats(bytes), action, settings) ? insertCr(bytes) : bytes;
};
