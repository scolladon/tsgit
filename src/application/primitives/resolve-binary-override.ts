import type { AttributeValue } from '../../domain/attributes/attribute-value.js';

export interface BinaryOverridePair {
  readonly patch?: 'binary' | 'text';
  readonly numstat?: 'binary' | 'text';
}

const EMPTY: BinaryOverridePair = {};
const FORCE_BINARY: BinaryOverridePair = { patch: 'binary', numstat: 'binary' };
const FORCE_TEXT: BinaryOverridePair = { patch: 'text', numstat: 'text' };
const TEXTCONV_BINARY_NUMSTAT: BinaryOverridePair = { patch: 'text', numstat: 'binary' };

/**
 * Map resolved `diff` attribute value to a binary/text override pair, honouring
 * a named driver's `diff.<name>.binary` tristate (`driverBinary`) exactly as
 * `resolveSimilarityOverride` does for rename/break scoring — `true` forces
 * binary, `false` forces text, `undefined` (unset/auto) defers to a content
 * sniff. Pinned against live git 2.55.0 across driverBinary x textconv x
 * content:
 *
 * - `driverBinary === true`: numstat is ALWAYS binary — patch is 'text' when
 *   a textconv is configured (its output is always clean text, so git shows
 *   it as a hunk despite the forced-binary numstat marker) and 'binary'
 *   otherwise ("Binary files ... differ").
 * - `driverBinary === false`: BOTH numstat and patch are ALWAYS text, even
 *   over a raw NUL-bearing blob with no textconv — the raw bytes are shown
 *   as a text hunk regardless of what a content sniff of them would say.
 * - `driverBinary === undefined` (unset): falls back to a content sniff.
 *   Without a textconv, `rawIsBinary` decides both patch and numstat
 *   identically (the caller's own bytes ARE the raw bytes). With a
 *   textconv, the PATCH bytes the caller renders are the textconv OUTPUT
 *   (never NUL, so its own downstream sniff already resolves 'text' without
 *   an override here) but the NUMSTAT bytes stay the RAW blob — git's
 *   `builtin_diffstat` never calls `fill_textconv` — so a raw-content sniff
 *   must be supplied explicitly (`named.rawIsBinary`) to keep the numstat
 *   binary/text DECISION truthful to the RAW blob; the caller counts from
 *   those same raw bytes separately, never from the converted PATCH bytes.
 */
export const resolveBinaryOverride = (
  value: AttributeValue,
  named: {
    readonly textconvConfigured: boolean;
    readonly driverBinary: boolean | undefined;
    readonly rawIsBinary: boolean;
  },
): BinaryOverridePair => {
  if (value === false) return FORCE_BINARY;
  if (value === true) return FORCE_TEXT;
  if (value === 'unspecified') return EMPTY;
  if (named.driverBinary === true) {
    return named.textconvConfigured ? TEXTCONV_BINARY_NUMSTAT : FORCE_BINARY;
  }
  if (named.driverBinary === false) return FORCE_TEXT;
  if (!named.textconvConfigured) return EMPTY;
  return named.rawIsBinary ? TEXTCONV_BINARY_NUMSTAT : FORCE_TEXT;
};
