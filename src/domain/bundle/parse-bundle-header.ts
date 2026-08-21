import { bundleBadHeader } from '../commands/error.js';
import { configFor, type HashConfig } from '../objects/hash-config.js';
import { ObjectId, RefName } from '../objects/object-id.js';
import { isOid } from '../objects/oid-pattern.js';
import { type ObjectFilter, parseObjectFilter } from '../protocol/object-filter.js';
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
const OBJECT_FORMAT_PREFIX = 'object-format=';
const FILTER_PREFIX = 'filter=';

const HEADER_ENCODER = new TextEncoder();

const byteLength = (s: string): number => HEADER_ENCODER.encode(s).length;

const findBlankLineOffset = (bytes: Uint8Array): number => {
  // Stryker disable next-line EqualityOperator,ArithmeticOperator: equivalent — an out-of-bounds Uint8Array read is undefined, so the extra iterations never satisfy the LF+LF check and the same offset is returned
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
): { version: BundleVersion; hashAlgorithm: BundleHashAlgorithm | undefined } => {
  if (line === MAGIC_V3) {
    return { version: 3, hashAlgorithm: undefined };
  }
  if (line !== MAGIC_V2) {
    throw bundleBadHeader(path, { reason: 'not-a-bundle' });
  }
  return { version: 2, hashAlgorithm: 'sha1' };
};

interface CapabilityState {
  readonly hashAlgorithm: BundleHashAlgorithm | undefined;
  readonly filter: ObjectFilter | undefined;
}

const applyCapability = (line: string, state: CapabilityState, path: string): CapabilityState => {
  const rest = line.slice(1);
  if (rest.startsWith(OBJECT_FORMAT_PREFIX)) {
    const algorithm = rest.slice(OBJECT_FORMAT_PREFIX.length);
    if (algorithm !== 'sha1' && algorithm !== 'sha256') {
      throw bundleBadHeader(path, { reason: 'unknown-hash-algorithm', algorithm });
    }
    return { hashAlgorithm: algorithm, filter: state.filter };
  }
  if (rest.startsWith(FILTER_PREFIX)) {
    const filter = parseObjectFilter(rest.slice(FILTER_PREFIX.length));
    return { hashAlgorithm: state.hashAlgorithm, filter };
  }
  throw bundleBadHeader(path, { reason: 'unknown-capability', capability: rest });
};

/**
 * Consumes the leading run of `@`-prefixed lines as capabilities (git's
 * grammar: capabilities precede any oid-bearing line). Stops at the first
 * line that is not a capability, whether that's a prerequisite, a ref, or
 * the end of the content — never scans past it.
 */
const parseCapabilities = (
  lines: ReadonlyArray<string>,
  path: string,
): { readonly consumed: number } & CapabilityState => {
  let state: CapabilityState = { hashAlgorithm: undefined, filter: undefined };
  let consumed = 0;
  for (const line of lines) {
    if (!line.startsWith('@')) break;
    state = applyCapability(line, state, path);
    consumed += 1;
  }
  return { consumed, ...state };
};

const requireHashConfig = (
  hashAlgorithm: BundleHashAlgorithm | undefined,
  line: string,
  path: string,
): HashConfig => {
  if (hashAlgorithm === undefined) {
    throw bundleBadHeader(path, { reason: 'malformed-header', line, length: byteLength(line) });
  }
  return configFor(hashAlgorithm);
};

const parsePrerequisiteLine = (
  line: string,
  path: string,
  config: HashConfig,
): BundlePrerequisite => {
  const rest = line.slice(1);
  const spaceIdx = rest.indexOf(' ');
  const oidStr = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
  const comment = spaceIdx === -1 ? '' : rest.slice(spaceIdx + 1);
  if (!isOid(oidStr, config)) {
    throw bundleBadHeader(path, { reason: 'malformed-header', line, length: byteLength(line) });
  }
  return { oid: ObjectId.from(oidStr), comment };
};

const parseRefLine = (line: string, path: string, config: HashConfig): BundleRef => {
  const spaceIdx = line.indexOf(' ');
  if (spaceIdx === -1) {
    throw bundleBadHeader(path, { reason: 'malformed-header', line, length: byteLength(line) });
  }
  const oidStr = line.slice(0, spaceIdx);
  const name = line.slice(spaceIdx + 1);
  if (!isOid(oidStr, config)) {
    throw bundleBadHeader(path, { reason: 'malformed-header', line, length: byteLength(line) });
  }
  return { oid: ObjectId.from(oidStr), name: RefName.from(name) };
};

/**
 * Parses the prerequisite (`-`) and ref lines that follow the capability
 * block. Each line requires a resolved hash algorithm — a v3 header whose
 * capability block never set one throws on the first such line, matching
 * git's `unrecognized header` for that exact line.
 */
const parseContentLines = (
  lines: ReadonlyArray<string>,
  path: string,
  hashAlgorithm: BundleHashAlgorithm | undefined,
): { prerequisites: BundlePrerequisite[]; refs: BundleRef[] } => {
  const prerequisites: BundlePrerequisite[] = [];
  const refs: BundleRef[] = [];
  for (const line of lines) {
    const config = requireHashConfig(hashAlgorithm, line, path);
    if (line.startsWith('-')) {
      prerequisites.push(parsePrerequisiteLine(line, path, config));
    } else {
      refs.push(parseRefLine(line, path, config));
    }
  }
  return { prerequisites, refs };
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
  filter: ObjectFilter | undefined;
} => {
  const headerText = new TextDecoder().decode(bytes.subarray(0, packOffset));
  const lines = headerText.split('\n').filter((l) => l.length > 0);

  const [magicLine, ...contentLines] = lines;
  if (magicLine === undefined) {
    throw bundleBadHeader(path, { reason: 'not-a-bundle' });
  }

  const { version, hashAlgorithm: magicHashAlgorithm } = parseMagicLine(magicLine, path);
  const capabilities =
    version === 3
      ? parseCapabilities(contentLines, path)
      : { consumed: 0, hashAlgorithm: magicHashAlgorithm, filter: undefined };
  const remainingLines = contentLines.slice(capabilities.consumed);
  const { prerequisites, refs } = parseContentLines(
    remainingLines,
    path,
    capabilities.hashAlgorithm,
  );

  return {
    version,
    // An empty v3 header (no capabilities, no prerequisite/ref lines to trip
    // over an unresolved algorithm) has nothing to disagree about — default
    // to sha1, matching v2's implicit algorithm.
    hashAlgorithm: capabilities.hashAlgorithm ?? 'sha1',
    prerequisites,
    refs,
    filter: capabilities.filter,
  };
};

/**
 * Diagnostic cap on the header prefix read when no blank-line terminator is
 * found. Bundle bytes are untrusted, so the reported `line` is bounded rather
 * than echoed whole. The bound is OBSERVABLE — a first line longer than this
 * is reported truncated, and `length` measures the truncated text — so it is
 * pinned by its own test rather than assumed unreachable.
 */
const HEADER_DIAGNOSTIC_CAP = 64;

const throwMissingBlankLine = (bytes: Uint8Array, path: string): never => {
  const prefix = bytes.subarray(0, Math.min(bytes.length, HEADER_DIAGNOSTIC_CAP));
  const headerText = new TextDecoder().decode(prefix);
  if (!headerText.startsWith(MAGIC_V2) && !headerText.startsWith(MAGIC_V3)) {
    throw bundleBadHeader(path, { reason: 'not-a-bundle' });
  }
  const firstLine = headerText.split('\n')[0] as string;
  throw bundleBadHeader(path, {
    reason: 'malformed-header',
    line: firstLine,
    length: byteLength(firstLine),
  });
};

/**
 * Parses a bundle header from raw bytes.
 *
 * Decodes the UTF-8 text header up to and including the blank terminating
 * line. Returns the structured header plus `packOffset` — the byte index
 * immediately after the blank line where the packfile begins.
 *
 * The bundle declares its own width: for v3, the `@object-format` capability
 * (parsed before any prerequisite or ref line) drives which oid width is
 * accepted, never the caller's repository. `path` is error-context only
 * (threaded into thrown errors for the caller).
 *
 * Throws on malformed magic, malformed content lines, an unrecognised or
 * unsupported capability, or an unrecognised hash algorithm.
 */
export const parseBundleHeader = (bytes: Uint8Array, path: string): ParsedBundleHeader => {
  const packOffset = findBlankLineOffset(bytes);
  if (packOffset === -1) {
    return throwMissingBlankLine(bytes, path);
  }

  const { version, hashAlgorithm, prerequisites, refs, filter } = decodeHeaderLines(
    bytes,
    packOffset,
    path,
  );

  return {
    version,
    hashAlgorithm,
    prerequisites,
    refs,
    packOffset,
    ...(filter !== undefined ? { filter } : {}),
  };
};
