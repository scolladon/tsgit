/**
 * Builds a `PackIndexEntries` slab from readable `{ id, crc32, offset }`
 * literals — the shape every test in this suite already declares. On the
 * precedent of `bitmap-writers.ts`: no `vitest`, no `fast-check`, so parity's
 * from-source module graph (Deno, Bun, `workerd`) can reach it too.
 *
 * Kept free of a loop-drain hazard on purpose: every array is pre-sized to
 * `entries.length`, so there is no `push(...spread)` anywhere near this file.
 */
import { hexToBytes } from '../../../src/domain/objects/encoding.ts';
import type { PackIndexEntries } from '../../../src/domain/storage/pack-order.ts';

export interface PackIndexEntryLiteral {
  readonly id: string;
  readonly crc32: number;
  readonly offset: number;
}

export function packIndexEntriesOf(
  entries: ReadonlyArray<PackIndexEntryLiteral>,
  digestLength: number,
): PackIndexEntries {
  const count = entries.length;
  const oids = new Uint8Array(count * digestLength);
  const crcValues = new Uint32Array(count);
  const offsets = new Float64Array(count);
  for (let i = 0; i < count; i += 1) {
    const entry = entries[i]!;
    oids.set(hexToBytes(entry.id), i * digestLength);
    crcValues[i] = entry.crc32;
    offsets[i] = entry.offset;
  }
  return { count, digestLength, oids, crcValues, offsets };
}

/**
 * Fills the index's own trailing checksum in place — `serializePackIndex`
 * reserves the region zeroed and does not hash its own output, exactly as
 * `serializePackRevIndex` does. Mirrors production's `buildIdx`; kept here so
 * the five test call sites that need it share one copy, which `jscpd` would
 * not catch drifting apart because it only scans `src/`.
 */
export async function sealPackIndex(
  idx: Uint8Array,
  /** Pass a bound call — `(b) => ctx.hash.hash(b)` — never the bare method.
   *  The memory adapter defines `hash` as an arrow class-property and so
   *  survives an unbound reference; the browser adapter uses a regular method
   *  reading `this.algoName`, and only the browser e2e run catches it. */
  hash: (bytes: Uint8Array) => Promise<Uint8Array>,
  digestLength: number,
): Promise<Uint8Array> {
  const digestStart = idx.length - digestLength;
  idx.set(await hash(idx.subarray(0, digestStart)), digestStart);
  return idx;
}
