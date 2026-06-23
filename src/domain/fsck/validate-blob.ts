import { isUnsafeSubmoduleName } from '../submodule/name.js';
import {
  MSG_GITATTRIBUTES_LARGE,
  MSG_GITATTRIBUTES_LINE_LENGTH,
  MSG_GITMODULES_LARGE,
  MSG_GITMODULES_NAME,
  MSG_GITMODULES_PARSE,
} from './msg-ids.js';
import { resolveSeverity } from './severity.js';
import type { FsckSeverity } from './types.js';

export interface BlobFinding {
  readonly msgId: string;
  readonly severity: FsckSeverity;
}

/** Maximum blob size git allows for .gitmodules and .gitattributes. */
const GITMODULES_MAX_BYTES = 100 * 1024 * 1024;
const GITATTRIBUTES_MAX_BYTES = 100 * 1024 * 1024;

/** Maximum line length for .gitattributes (git's GITATTRIBUTES_LINE_LENGTH_LIMIT). */
const GITATTRIBUTES_MAX_LINE_BYTES = 2048;

/**
 * Minimal tolerant INI section parser for .gitmodules validation.
 * Returns the list of submodule names found, or throws if the file
 * cannot be parsed at all (signalling gitmodulesParse).
 */
function parseGitmodulesNames(text: string): {
  readonly names: ReadonlyArray<string>;
  readonly parseError: boolean;
} {
  const names: string[] = [];
  let parseError = false;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      const closeIdx = line.indexOf(']');
      if (closeIdx === -1) {
        parseError = true;
        continue;
      }
      const header = line.slice(1, closeIdx);
      const submodulePrefix = 'submodule "';
      if (header.startsWith(submodulePrefix) && header.endsWith('"')) {
        names.push(header.slice(submodulePrefix.length, -1));
      }
    }
  }

  return { names, parseError };
}

/** Validate a .gitmodules blob body, returning ordered findings. */
function validateGitmodulesBlob(raw: Uint8Array, strict: boolean): ReadonlyArray<BlobFinding> {
  const findings: BlobFinding[] = [];

  if (raw.length > GITMODULES_MAX_BYTES) {
    findings.push({
      msgId: MSG_GITMODULES_LARGE,
      severity: resolveSeverity(MSG_GITMODULES_LARGE, strict),
    });
    return findings;
  }

  const text = new TextDecoder().decode(raw);
  const { names, parseError } = parseGitmodulesNames(text);

  if (parseError) {
    findings.push({
      msgId: MSG_GITMODULES_PARSE,
      severity: resolveSeverity(MSG_GITMODULES_PARSE, strict),
    });
  }

  for (const name of names) {
    if (isUnsafeSubmoduleName(name)) {
      findings.push({
        msgId: MSG_GITMODULES_NAME,
        severity: resolveSeverity(MSG_GITMODULES_NAME, strict),
      });
    }
  }

  return findings;
}

/** Validate a .gitattributes blob body, returning ordered findings. */
function validateGitattributesBlob(raw: Uint8Array, strict: boolean): ReadonlyArray<BlobFinding> {
  const findings: BlobFinding[] = [];

  if (raw.length > GITATTRIBUTES_MAX_BYTES) {
    findings.push({
      msgId: MSG_GITATTRIBUTES_LARGE,
      severity: resolveSeverity(MSG_GITATTRIBUTES_LARGE, strict),
    });
    return findings;
  }

  const text = new TextDecoder().decode(raw);
  for (const line of text.split('\n')) {
    const lineBytes = new TextEncoder().encode(line).length;
    if (lineBytes > GITATTRIBUTES_MAX_LINE_BYTES) {
      findings.push({
        msgId: MSG_GITATTRIBUTES_LINE_LENGTH,
        severity: resolveSeverity(MSG_GITATTRIBUTES_LINE_LENGTH, strict),
      });
      return findings;
    }
  }

  return findings;
}

/** Validate a blob object body for special-file content checks. */
export function validateBlob(
  raw: Uint8Array,
  strict: boolean,
  fileName?: string,
): ReadonlyArray<BlobFinding> {
  if (fileName === '.gitmodules') return validateGitmodulesBlob(raw, strict);
  if (fileName === '.gitattributes') return validateGitattributesBlob(raw, strict);
  return [];
}
