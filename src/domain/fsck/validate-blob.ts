import { isUnsafeSubmoduleName } from '../submodule/name.js';
import {
  MSG_GITATTRIBUTES_LARGE,
  MSG_GITATTRIBUTES_LINE_LENGTH,
  MSG_GITMODULES_LARGE,
  MSG_GITMODULES_NAME,
  MSG_GITMODULES_PARSE,
  MSG_GITMODULES_URL,
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
 * Process one trimmed line of a .gitmodules INI blob.
 * Mutates `names` (submodule section headers) and `urls` (url = … key–values).
 * Returns the updated parseError flag.
 */
function processGitmodulesLine(
  line: string,
  names: string[],
  urls: string[],
  parseError: boolean,
): boolean {
  if (line === '' || line.startsWith('#') || line.startsWith(';')) return parseError;
  if (line.startsWith('[')) {
    const closeIdx = line.indexOf(']');
    if (closeIdx === -1) return true;
    const header = line.slice(1, closeIdx);
    const submodulePrefix = 'submodule "';
    if (header.startsWith(submodulePrefix) && header.endsWith('"')) {
      names.push(header.slice(submodulePrefix.length, -1));
    }
    return parseError;
  }
  const eqIdx = line.indexOf('=');
  if (eqIdx !== -1) {
    const key = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1).trim();
    if (key === 'url') urls.push(value);
  }
  return parseError;
}

/**
 * Minimal tolerant INI parser for .gitmodules validation.
 * Returns submodule names and URLs found, plus parseError when the blob
 * cannot be parsed at all (signalling gitmodulesParse).
 */
function parseGitmodules(text: string): {
  readonly names: ReadonlyArray<string>;
  readonly urls: ReadonlyArray<string>;
  readonly parseError: boolean;
} {
  const names: string[] = [];
  const urls: string[] = [];
  let parseError = false;

  for (const rawLine of text.split('\n')) {
    parseError = processGitmodulesLine(rawLine.trim(), names, urls, parseError);
  }

  return { names, urls, parseError };
}

/**
 * Return true when a submodule URL is disallowed by git's fsck.
 *
 * Pinned real git 2.54.0: URLs starting with '-' are flagged as
 * `gitmodulesUrl: disallowed submodule url` (prevents command injection when
 * the URL is passed as a git subprocess argument — CVE-2018-10976 lineage).
 */
const isDisallowedSubmoduleUrl = (url: string): boolean => url.startsWith('-');

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
  const { names, urls, parseError } = parseGitmodules(text);

  if (parseError) {
    findings.push({
      msgId: MSG_GITMODULES_PARSE,
      severity: resolveSeverity(MSG_GITMODULES_PARSE, strict),
    });
  }

  for (const url of urls) {
    if (isDisallowedSubmoduleUrl(url)) {
      findings.push({
        msgId: MSG_GITMODULES_URL,
        severity: resolveSeverity(MSG_GITMODULES_URL, strict),
      });
    }
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
