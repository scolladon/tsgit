import type { AttributeValue } from '../../domain/attributes/attribute-value.js';

export interface BinaryOverridePair {
  readonly patch?: 'binary' | 'text';
  readonly numstat?: 'binary' | 'text';
}

const EMPTY: BinaryOverridePair = {};
const FORCE_BINARY: BinaryOverridePair = { patch: 'binary', numstat: 'binary' };
const FORCE_TEXT: BinaryOverridePair = { patch: 'text', numstat: 'text' };
const TEXTCONV_BINARY_NUMSTAT: BinaryOverridePair = { patch: 'text', numstat: 'binary' };

/** Map resolved `diff` attribute value to binary/text override pair. */
export const resolveBinaryOverride = (
  value: AttributeValue,
  named: { readonly textconvConfigured: boolean; readonly rawIsBinary: boolean },
): BinaryOverridePair => {
  if (value === false) return FORCE_BINARY;
  if (value === true) return FORCE_TEXT;
  if (value === 'unspecified') return EMPTY;
  if (!named.textconvConfigured) return EMPTY;
  return named.rawIsBinary ? TEXTCONV_BINARY_NUMSTAT : FORCE_TEXT;
};
