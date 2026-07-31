import { isBinary } from './line-diff.js';

/**
 * A path's explicit binary-vs-text decision, resolved from its `diff`
 * attribute: `-diff` ⇒ `'binary'`, a set `diff` (bare, or a named driver whose
 * textconv converts to text) ⇒ `'text'`. `undefined` means no attribute
 * decided, so git's NUL-window content sniff has the say.
 */
export type BinaryOverride = 'binary' | 'text';

/** True when an attribute decided binary outright, before any byte is read. */
export function forcesBinary(override: BinaryOverride | undefined): boolean {
  return override === 'binary';
}

/**
 * True while no attribute has decided, so the NUL-window content sniff still
 * has the say. This is the ONE switch that suppresses a content sniff under a
 * forced-text attribute — the whole-buffer sniff below, and the incremental
 * one the line-digest scanner runs — so the numstat counts, the patch body and
 * the whitespace drop verdict cannot drift apart on the same path.
 */
export function sniffDecides(override: BinaryOverride | undefined): boolean {
  return override === undefined;
}

/** The binary verdict for one side's full content. */
export function sideIsBinary(bytes: Uint8Array, override: BinaryOverride | undefined): boolean {
  return sniffDecides(override) ? isBinary(bytes) : forcesBinary(override);
}

/** The binary verdict for a pair of sides — either side binary makes the pair binary. */
export function pairIsBinary(
  old: Uint8Array,
  next: Uint8Array,
  override: BinaryOverride | undefined,
): boolean {
  return sideIsBinary(old, override) || sideIsBinary(next, override);
}
