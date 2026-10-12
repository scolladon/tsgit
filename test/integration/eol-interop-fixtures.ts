/**
 * Shared fixtures for the EOL conversion interop suites: fixture bytes, the
 * add / checkout matrices transcribed from canonical git, a repo initialiser
 * that writes configuration where git (and tsgit) read it, and readers.
 */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { runGit, runGitBytes } from './interop-helpers.js';

const text = (latin1: string): Uint8Array => new Uint8Array(Buffer.from(latin1, 'latin1'));

const CR = 0x0d;
const LF = 0x0a;
const NUL = 0x00;
const CR_LABEL = 'R';
const LF_LABEL = 'N';
const NUL_LABEL = '0';

export interface NamedFixture {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** The five matrix fixtures, in the order the cell codes list them. */
export const MATRIX_FIXTURES: ReadonlyArray<NamedFixture> = [
  { name: 'lf', bytes: text('a\nb\n') },
  { name: 'crlf', bytes: text('a\r\nb\r\n') },
  { name: 'mixed', bytes: text('a\r\nb\n') },
  { name: 'nul', bytes: text('a\0\r\nb\r\n') },
  { name: 'lone-cr', bytes: text('a\rb\r\n') },
];

export const EDGE_FIXTURES = {
  'nul-lf': text('a\0\nb\n'),
  'lone-cr-lf': text('a\rb\n'),
  'trail-cr': text('a\r'),
  'no-eol': text('a\nb'),
  'crlf-no-eol': text('a\r\nb'),
  empty: text(''),
} as const;

export const HEURISTIC_FIXTURES = {
  'nul-far': text(`${'a'.repeat(9000)}\0\r\n`),
  r127: text(`${'a'.repeat(127)}\x01\r\n`),
  r128: text(`${'a'.repeat(128)}\x01\r\n`),
  r128eof: text(`${'a'.repeat(128)}\x01\r\n\x1a`),
  r128x2eof: text(`${'a'.repeat(128)}\x01\x01\r\n\x1a`),
  ctl: text('\x1b\t\b\x0cx\r\n'),
} as const;

/** `a1` and `c3` are CRLF, `b2` is LF: the partial-failure trio under `core.safecrlf=true`. */
export const SAFECRLF_TRIO: ReadonlyArray<NamedFixture> = [
  { name: 'a1', bytes: text('one\r\n') },
  { name: 'b2', bytes: text('two\n') },
  { name: 'c3', bytes: text('three\r\n') },
];

export const IDENT_FIXTURES = {
  a: text('x $Id$ y\n'),
  b: text('$Id: deadbeef $\n'),
  c: text('$Id:garbage$\n'),
  d: text('$Id: has space x $\n'),
  e: text('$Id: nl\n$ $Id$\n'),
  f: text('a\0$Id$\n'),
  g: text('$Id$$Id$\n'),
  h: text('$Id\n'),
} as const;

/** The blob on which git's streamed and in-core `ident` expanders disagree. */
export const IDENT_DIVERGENCE_BLOB: Uint8Array = text('$$Id$\n$Id:a b$\n$Id: a\tb $\n$Id$Id$\n');

export const FILTER_FIXTURE = {
  attributes: '* text ident filter=t',
  clean: "printf 'Z\\r\\n$Id: q $\\r\\n'; cat",
  smudge: "LC_ALL=C tr 'R$\\r' 'r#R'",
  worktree: text('aR\r\nb\r\n'),
} as const;

export type AutoCrlf = 'unset' | 'false' | 'true' | 'input';
export type CoreEolSetting = 'unset' | 'lf' | 'crlf' | 'native';

/** One attribute per column; `undefined` leaves the path without attributes. */
export const ATTRIBUTE_COLUMNS: ReadonlyArray<string | undefined> = [
  undefined,
  'text',
  '-text',
  'text=auto',
  'eol=lf',
  'eol=crlf',
  'binary',
];

/** `=` the worktree bytes, `L` every CR before an LF removed, `C` every LF not after a CR made CRLF. */
export type CellCode = '=' | 'L' | 'C';

const dropCrBeforeLf = (bytes: Uint8Array): Uint8Array =>
  bytes.filter((byte, index) => !(byte === CR && bytes[index + 1] === LF));

const crlfBeforeBareLf = (bytes: Uint8Array): Uint8Array => {
  const out: number[] = [];
  bytes.forEach((byte, index) => {
    if (byte === LF && bytes[index - 1] !== CR) out.push(CR);
    out.push(byte);
  });
  return new Uint8Array(out);
};

export const expectedBytes = (code: string, fixture: Uint8Array): Uint8Array => {
  if (code === 'L') return dropCrBeforeLf(fixture);
  if (code === 'C') return crlfBeforeBareLf(fixture);
  return fixture;
};

export interface AddCell {
  readonly blobs: string;
  readonly warnings: number;
}

export interface MatrixRow<Cell> {
  readonly autoCrlf: AutoCrlf;
  readonly eol: CoreEolSetting;
  readonly cells: ReadonlyArray<Cell>;
}

const addCell = (blobs: string, warnings: number): AddCell => ({ blobs, warnings });
const NO_CONVERSION = addCell('=====', 0);

const SHARED_ADD_CELLS = [
  addCell('=LL==', 2), // text=auto
  addCell('=LLLL', 4), // eol=lf
  addCell('=LLLL', 2), // eol=crlf
  NO_CONVERSION, // binary
] as const;

const addProfile = (
  none: AddCell,
  textCell: AddCell,
  eolLf: AddCell = SHARED_ADD_CELLS[1],
): ReadonlyArray<AddCell> => [
  none,
  textCell,
  NO_CONVERSION,
  SHARED_ADD_CELLS[0],
  eolLf,
  SHARED_ADD_CELLS[2],
  SHARED_ADD_CELLS[3],
];

const ADD_NO_AUTOCRLF_LF = addProfile(NO_CONVERSION, addCell('=LLLL', 4));
const ADD_NO_AUTOCRLF_CRLF = addProfile(NO_CONVERSION, addCell('=LLLL', 2));
const ADD_AUTOCRLF_TRUE = addProfile(addCell('=LL==', 2), addCell('=LLLL', 2));
const ADD_AUTOCRLF_INPUT = addProfile(addCell('=LL==', 2), addCell('=LLLL', 4));

const EOL_SETTINGS: ReadonlyArray<CoreEolSetting> = ['unset', 'lf', 'crlf', 'native'];

const expandRows = <Cell>(
  autoCrlf: AutoCrlf,
  profileFor: (eol: CoreEolSetting) => ReadonlyArray<Cell>,
): ReadonlyArray<MatrixRow<Cell>> =>
  EOL_SETTINGS.map((eol) => ({ autoCrlf, eol, cells: profileFor(eol) }));

/** Blob bytes and `warning:` line count per config row and attribute column (default `core.safecrlf`). */
export const ADD_MATRIX: ReadonlyArray<MatrixRow<AddCell>> = [
  ...expandRows('unset', (eol) => (eol === 'crlf' ? ADD_NO_AUTOCRLF_CRLF : ADD_NO_AUTOCRLF_LF)),
  ...expandRows('false', (eol) => (eol === 'crlf' ? ADD_NO_AUTOCRLF_CRLF : ADD_NO_AUTOCRLF_LF)),
  ...expandRows('true', () => ADD_AUTOCRLF_TRUE),
  ...expandRows('input', () => ADD_AUTOCRLF_INPUT),
];

const checkoutProfile = (none: string, textCell: string, auto: string): ReadonlyArray<string> => [
  none,
  textCell,
  '=====',
  auto,
  '=====',
  'C=C==',
  '=====',
];

const CHECKOUT_PLAIN = checkoutProfile('=====', '=====', '=====');
const CHECKOUT_NO_AUTOCRLF_CRLF = checkoutProfile('=====', 'C=C==', 'C====');
const CHECKOUT_AUTOCRLF_TRUE = checkoutProfile('C====', 'C=C==', 'C====');

/** Worktree bytes per config row and attribute column, blobs committed raw. */
export const CHECKOUT_MATRIX: ReadonlyArray<MatrixRow<string>> = [
  ...expandRows('unset', (eol) => (eol === 'crlf' ? CHECKOUT_NO_AUTOCRLF_CRLF : CHECKOUT_PLAIN)),
  ...expandRows('false', (eol) => (eol === 'crlf' ? CHECKOUT_NO_AUTOCRLF_CRLF : CHECKOUT_PLAIN)),
  ...expandRows('true', () => CHECKOUT_AUTOCRLF_TRUE),
  ...expandRows('input', () => CHECKOUT_PLAIN),
];

/**
 * The native line ending decides the `unset` and `native` rows; the tables
 * were pinned on a host whose native ending is LF, so a CRLF host reads the
 * `crlf` row instead.
 */
export const hostNativeIsCrlf = (): boolean => process.platform === 'win32';

export const tableEolFor = (eol: CoreEolSetting): CoreEolSetting =>
  hostNativeIsCrlf() && (eol === 'unset' || eol === 'native') ? 'crlf' : eol;

export const findRow = <Cell>(
  table: ReadonlyArray<MatrixRow<Cell>>,
  autoCrlf: AutoCrlf,
  eol: CoreEolSetting,
): MatrixRow<Cell> => {
  const wanted = tableEolFor(eol);
  const row = table.find(
    (candidate) => candidate.autoCrlf === autoCrlf && candidate.eol === wanted,
  );
  if (row === undefined) throw new Error(`no matrix row for autocrlf=${autoCrlf} eol=${wanted}`);
  return row;
};

export interface EolRepoOptions {
  readonly autoCrlf?: Exclude<AutoCrlf, 'unset'>;
  readonly eol?: Exclude<CoreEolSetting, 'unset'>;
  readonly safeCrlf?: 'true' | 'false' | 'warn';
  readonly infoAttributes?: ReadonlyArray<string>;
  readonly gitattributes?: string;
}

const CONFIG_KEYS = [
  ['core.autocrlf', 'autoCrlf'],
  ['core.eol', 'eol'],
  ['core.safecrlf', 'safeCrlf'],
] as const;

/** Writes the EOL settings into the repository config (not `-c`): tsgit reads the same file. */
export const setEolConfig = (dir: string, options: EolRepoOptions): void => {
  for (const [key, option] of CONFIG_KEYS) {
    const value = options[option];
    if (value !== undefined) runGit(['-C', dir, 'config', key, value]);
  }
};

export const writeInfoAttributes = (dir: string, lines: ReadonlyArray<string>): void => {
  mkdirSync(path.join(dir, '.git', 'info'), { recursive: true });
  writeFileSync(path.join(dir, '.git', 'info', 'attributes'), lines.map((l) => `${l}\n`).join(''));
};

export const initEolRepo = (dir: string, options: EolRepoOptions = {}): void => {
  runGit(['-c', 'init.defaultBranch=main', 'init', '-q', dir]);
  setEolConfig(dir, options);
  if (options.infoAttributes !== undefined) writeInfoAttributes(dir, options.infoAttributes);
  if (options.gitattributes !== undefined) {
    writeFileSync(path.join(dir, '.gitattributes'), options.gitattributes);
  }
};

/** The staged blob bytes of `filePath`, untouched by any decoding. */
export const blobAt = (dir: string, filePath: string): Uint8Array =>
  runGitBytes(['-C', dir, 'cat-file', 'blob', `:${filePath}`]);

const OBJECT_FAN_OUT = /^[0-9a-f]{2}$/;

export const looseObjectIds = (dir: string): ReadonlyArray<string> => {
  const objects = path.join(dir, '.git', 'objects');
  return readdirSync(objects)
    .filter((entry) => OBJECT_FAN_OUT.test(entry))
    .flatMap((fanOut) => readdirSync(path.join(objects, fanOut)).map((rest) => fanOut + rest))
    .sort();
};

/** Bytes as text for readable diffs: CR becomes `R`, LF `N`, NUL `0`. */
export const enc = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => {
    if (byte === CR) return CR_LABEL;
    if (byte === LF) return LF_LABEL;
    if (byte === NUL) return NUL_LABEL;
    return String.fromCharCode(byte);
  }).join('');

export interface SafecrlfData {
  readonly path: string;
  readonly loss: 'crlf-to-lf' | 'lf-to-crlf';
}

const LOSS_DIRECTION = {
  'crlf-to-lf': { from: 'CRLF', to: 'LF' },
  'lf-to-crlf': { from: 'LF', to: 'CRLF' },
} as const;

/** git's stderr line for a notice (`warning`) or a refusal (`fatal`), from structured data only. */
export const reconstructSafecrlfLine = (
  data: SafecrlfData,
  severity: 'warning' | 'fatal',
): string => {
  const { from, to } = LOSS_DIRECTION[data.loss];
  if (severity === 'fatal') return `fatal: ${from} would be replaced by ${to} in ${data.path}`;
  return `warning: in the working copy of '${data.path}', ${from} will be replaced by ${to} the next time Git touches it`;
};
