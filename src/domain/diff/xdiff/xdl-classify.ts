import { bytesEqual } from '../../objects/encoding.js';
import { type LineKey, normalizeLine } from '../whitespace.js';

export interface LineClasses {
  readonly ours: Int32Array;
  readonly theirs: Int32Array;
  readonly classCount: number;
}

const LF = 0x0a;
const DJB2_SEED = 5381;
const DJB2_MULTIPLIER = 33;
const EMPTY_SLOT = -1;

// git's djb2 (`xdl_hash_record_verbatim`, xdiff/xutils.c) folded to 32 bits:
// only bucket selection needs it, never equality — a hash hit is always
// confirmed against the full record bytes below. The loop stops before a
// trailing LF (git's line scan does too), so a terminated and an
// unterminated line normally hash alike; `classify`'s byte comparison over
// the WHOLE record (LF included) is what actually tells them apart.
function hashLineBytes(bytes: Uint8Array): number {
  const length = bytes.length;
  const end = length > 0 && bytes[length - 1] === LF ? length - 1 : length;
  let hash = DJB2_SEED;
  for (let i = 0; i < end; i++) {
    hash = (Math.imul(hash, DJB2_MULTIPLIER) + bytes[i]!) >>> 0;
  }
  return hash;
}

function nextPowerOfTwo(minimum: number): number {
  let capacity = 1;
  while (capacity < minimum) capacity *= 2;
  return capacity;
}

interface ClassTable {
  readonly slotClass: Int32Array;
  readonly slotHash: Uint32Array;
  readonly representative: Uint8Array[];
}

// git's classifier chains a linked list per bucket; this table is an
// open-addressing Int32Array instead — sized so probing always terminates
// (capacity is at least twice the line count, so a free slot always exists).
// `slotHash` is a Uint32Array, not Int32Array: `hashLineBytes` returns an
// unsigned 32-bit value, and a signed lane would reinterpret every hash at
// or above 2^31 as negative, breaking the `=== hash` re-read below for
// roughly half of all inputs.
function createClassTable(lineCount: number): ClassTable {
  const capacity = nextPowerOfTwo(Math.max(2 * lineCount, 1));
  return {
    slotClass: new Int32Array(capacity).fill(EMPTY_SLOT),
    slotHash: new Uint32Array(capacity),
    representative: [],
  };
}

// Assigns `bytes` a class id: an existing one when a probed slot's stored
// hash AND bytes both match, or the next id in first-appearance order
// otherwise. `hash` is supplied by the caller (see `hashLineSide`) rather
// than recomputed here, so a caller walking the same blob's lines across
// several calls hashes them only once. The two typed arrays are filled in
// place — the hot-path exception to immutability the table exists for,
// since a per-line allocation here would undo the point of interning.
function classify(table: ClassTable, bytes: Uint8Array, hash: number): number {
  const { slotClass, slotHash, representative } = table;
  const mask = slotClass.length - 1;
  let slot = hash & mask;
  while (slotClass[slot] !== EMPTY_SLOT) {
    const candidate = slotClass[slot]!;
    if (slotHash[slot] === hash && bytesEqual(representative[candidate]!, bytes)) {
      return candidate;
    }
    slot = (slot + 1) & mask;
  }
  const id = representative.length;
  slotClass[slot] = id;
  slotHash[slot] = hash;
  representative.push(bytes);
  return id;
}

// Raw bytes when no lineKey is given at all; the key's normalized form
// (LF stripped only for an active key) otherwise — mirrors what the deleted
// `buildLineEquality` compared, so a caller passing `NONE_KEY` explicitly
// still classifies identically to passing no key.
function keyBytesOf(line: Uint8Array, lineKey: LineKey | undefined): Uint8Array {
  return lineKey === undefined ? line : normalizeLine(line, lineKey);
}

/**
 * Per-side line hashing (git's `xdl_hash_record_verbatim` loop, run once per
 * line): a pure function of `lines` and `lineKey` alone, so equal inputs
 * always produce an equal `Uint32Array` — the property a caller amortizing
 * this across several classifications (see `line-diff.ts`'s hop-to-hop hash
 * cache) depends on.
 *
 * `normalizedOut`, when given, is filled in place with each line's
 * normalized bytes (the same `Uint8Array` `hashLineBytes` hashed) — the hot-path
 * exception to immutability this parameter exists for. A caller that
 * immediately classifies these same lines afterwards (`line-diff.ts`'s
 * fresh-hash path) hands its own pre-sized array in and reuses it there,
 * instead of `classifySide` normalizing every line a second time.
 */
export function hashLineSide(
  lines: ReadonlyArray<Uint8Array>,
  lineKey: LineKey | undefined,
  normalizedOut?: Uint8Array[],
): Uint32Array {
  const hashes = new Uint32Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    const bytes = keyBytesOf(lines[i]!, lineKey);
    hashes[i] = hashLineBytes(bytes);
    if (normalizedOut !== undefined) normalizedOut[i] = bytes;
  }
  return hashes;
}

function classifySide(
  table: ClassTable,
  lines: ReadonlyArray<Uint8Array>,
  lineKey: LineKey | undefined,
  hashes: Uint32Array,
  ids: Int32Array,
  normalized: ReadonlyArray<Uint8Array> | undefined,
): void {
  for (let i = 0; i < lines.length; i++) {
    const bytes = normalized?.[i] ?? keyBytesOf(lines[i]!, lineKey);
    ids[i] = classify(table, bytes, hashes[i]!);
  }
}

/**
 * git's `xdl_classify_record`: every line of `ours` then every line of
 * `theirs` gets an integer class id, assigned in first-appearance order, so
 * that two lines share an id exactly when their (optionally normalized)
 * bytes are equal. The Myers core compares these ids instead of re-reading
 * or re-normalizing bytes on every probe.
 *
 * `oursHashes`/`theirsHashes` are each side's `hashLineSide` output, aligned
 * index-for-index with `ours`/`theirs` — supplied by the caller (rather than
 * hashed again here) so a caller that already hashed one side elsewhere can
 * pass that array straight through.
 *
 * `oursNormalized`/`theirsNormalized`, when given, are that same `hashLineSide`
 * call's `normalizedOut` — reused here instead of normalizing every line a
 * second time. Absent for a side whose hashes came from elsewhere (a
 * precomputed hop-to-hop cache never captured them), which still classifies
 * correctly by normalizing itself.
 */
export function classifyLines(
  ours: ReadonlyArray<Uint8Array>,
  theirs: ReadonlyArray<Uint8Array>,
  lineKey: LineKey | undefined,
  oursHashes: Uint32Array,
  theirsHashes: Uint32Array,
  oursNormalized?: ReadonlyArray<Uint8Array>,
  theirsNormalized?: ReadonlyArray<Uint8Array>,
): LineClasses {
  const oursIds = new Int32Array(ours.length);
  const theirsIds = new Int32Array(theirs.length);
  if (ours.length + theirs.length === 0) {
    return { ours: oursIds, theirs: theirsIds, classCount: 0 };
  }
  const table = createClassTable(ours.length + theirs.length);
  classifySide(table, ours, lineKey, oursHashes, oursIds, oursNormalized);
  classifySide(table, theirs, lineKey, theirsHashes, theirsIds, theirsNormalized);
  return { ours: oursIds, theirs: theirsIds, classCount: table.representative.length };
}
