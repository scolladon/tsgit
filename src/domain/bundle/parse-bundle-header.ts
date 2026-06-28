import { bundleBadHeader, bundleUnsupportedVersion } from '../commands/error.js';
import { ObjectId, RefName } from '../objects/object-id.js';
import type {
  BundleHashAlgorithm,
  BundlePrerequisite,
  BundleRef,
  BundleVersion,
  ParsedBundleHeader,
} from './types.js';

const LF = 10;
const MAGIC_V2 = '# v2 git bundle';
const MAGIC_V3 = '# v3 git bundle';
const HEX_PATTERN = /^[0-9a-f]{40}$/;

const isHex40 = (s: string): boolean => HEX_PATTERN.test(s);

const findBlankLineOffset = (bytes: Uint8Array): number => {
  // equivalent-mutant: i<=bytes.length-1 / bytes.length+1 — extra iterations read bytes[length]=undefined; LF check still fails
  for (let i = 0; i < bytes.length - 1; i++) {
    if (bytes[i] === LF && bytes[i + 1] === LF) {
      return i + 2;
    }
  }
  return -1;
};

const parseMagicLine = (
  line: string,
  path: string,
): { version: BundleVersion; hashAlgorithm: BundleHashAlgorithm } => {
  if (line === MAGIC_V3) {
    throw bundleUnsupportedVersion(path, 3);
  }
  if (line !== MAGIC_V2) {
    throw bundleBadHeader(path, 'not-a-bundle');
  }
  return { version: 2, hashAlgorithm: 'sha1' };
};

const parsePrerequisiteLine = (line: string, path: string): BundlePrerequisite => {
  const rest = line.slice(1);
  const spaceIdx = rest.indexOf(' ');
  const oidStr = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
  const comment = spaceIdx === -1 ? '' : rest.slice(spaceIdx + 1);
  if (!isHex40(oidStr)) {
    throw bundleBadHeader(path, 'malformed-header');
  }
  return { oid: ObjectId.from(oidStr), comment };
};

const parseRefLine = (line: string, path: string): BundleRef => {
  const spaceIdx = line.indexOf(' ');
  if (spaceIdx === -1) {
    throw bundleBadHeader(path, 'malformed-header');
  }
  const oidStr = line.slice(0, spaceIdx);
  const name = line.slice(spaceIdx + 1);
  if (!isHex40(oidStr)) {
    throw bundleBadHeader(path, 'malformed-header');
  }
  return { oid: ObjectId.from(oidStr), name: RefName.from(name) };
};

const decodeHeaderLines = (
  bytes: Uint8Array,
  packOffset: number,
  path: string,
): {
  version: BundleVersion;
  hashAlgorithm: BundleHashAlgorithm;
  prerequisites: ReadonlyArray<BundlePrerequisite>;
  refs: ReadonlyArray<BundleRef>;
} => {
  const headerText = new TextDecoder().decode(bytes.subarray(0, packOffset));
  const lines = headerText.split('\n').filter((l) => l.length > 0);

  const [magicLine, ...contentLines] = lines;
  if (magicLine === undefined) {
    throw bundleBadHeader(path, 'not-a-bundle');
  }

  const { version, hashAlgorithm } = parseMagicLine(magicLine, path);
  const prerequisites: BundlePrerequisite[] = [];
  const refs: BundleRef[] = [];

  for (const line of contentLines) {
    if (line.startsWith('-')) {
      prerequisites.push(parsePrerequisiteLine(line, path));
    } else if (line.startsWith('@')) {
      // equivalent-mutant: ConditionalExpression→false — @-prefixed lines have no space and non-hex chars; parseRefLine throws malformed-header either way
      throw bundleBadHeader(path, 'malformed-header');
    } else {
      refs.push(parseRefLine(line, path));
    }
  }

  return { version, hashAlgorithm, prerequisites, refs };
};

const throwMissingBlankLine = (bytes: Uint8Array, path: string): never => {
  // equivalent-mutant: Math.max — subarray auto-clamps end to bytes.length; Math.max(bytes.length,64)≥bytes.length produces the same slice
  const prefix = bytes.subarray(0, Math.min(bytes.length, 64));
  const headerText = new TextDecoder().decode(prefix);
  const firstLine = headerText.split('\n')[0] as string;
  if (firstLine === MAGIC_V3) {
    throw bundleUnsupportedVersion(path, 3);
  }
  // equivalent-mutant: endsWith(MAGIC_V3) — V3 is caught at L103 (firstLine===MAGIC_V3); non-bundle data never ends with the V3 magic string
  if (!headerText.startsWith(MAGIC_V2) && !headerText.startsWith(MAGIC_V3)) {
    throw bundleBadHeader(path, 'not-a-bundle');
  }
  throw bundleBadHeader(path, 'malformed-header');
};

/**
 * Parses a bundle header from raw bytes.
 *
 * Decodes the UTF-8 text header up to and including the blank terminating
 * line. Returns the structured header plus `packOffset` — the byte index
 * immediately after the blank line where the packfile begins.
 *
 * Throws on malformed magic, unsupported version, or malformed content lines.
 * `path` is error-context only (threaded into thrown errors for the caller).
 */
export const parseBundleHeader = (bytes: Uint8Array, path: string): ParsedBundleHeader => {
  const packOffset = findBlankLineOffset(bytes);
  if (packOffset === -1) {
    return throwMissingBlankLine(bytes, path);
  }

  const { version, hashAlgorithm, prerequisites, refs } = decodeHeaderLines(
    bytes,
    packOffset,
    path,
  );

  return { version, hashAlgorithm, prerequisites, refs, packOffset };
};
