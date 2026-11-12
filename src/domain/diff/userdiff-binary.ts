import type { AttributeValue } from '../attributes/attribute-value.js';
import type { BinaryOverride } from './binary-decision.js';

/** git's builtin userdiff drivers: `diff=<name>` finds one even with no config. */
const BUILTIN_DRIVERS: ReadonlySet<string> = new Set([
  'ada',
  'bash',
  'bibtex',
  'cpp',
  'csharp',
  'css',
  'dts',
  'elixir',
  'fortran',
  'fountain',
  'golang',
  'html',
  'java',
  'kotlin',
  'markdown',
  'matlab',
  'objc',
  'pascal',
  'perl',
  'php',
  'python',
  'r',
  'ruby',
  'rust',
  'scheme',
  'swift',
  'tex',
]);

// An attribute that names no known driver falls back to the default driver, as userdiff_find_by_path does.
const DEFAULT_DRIVER = 'default';

export interface DiffDriverBinary {
  readonly binary?: boolean;
}

export type DiffDrivers = ReadonlyMap<string, DiffDriverBinary> | undefined;

const tristate = (binary: boolean | undefined): BinaryOverride | undefined => {
  if (binary === undefined) return undefined;
  return binary ? 'binary' : 'text';
};

const isDriver = (drivers: DiffDrivers, name: string): boolean =>
  drivers?.has(name) === true || BUILTIN_DRIVERS.has(name);

/** The `diff` attribute's verdict for a path; `undefined` leaves it to the NUL sniff. */
export const userdiffBinaryOverride = (
  value: AttributeValue,
  drivers: DiffDrivers,
): BinaryOverride | undefined => {
  if (value === false) return 'binary';
  if (value === true) return 'text';
  const named =
    typeof value === 'object' && isDriver(drivers, value.set) ? value.set : DEFAULT_DRIVER;
  return tristate(drivers?.get(named)?.binary);
};
