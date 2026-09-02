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
