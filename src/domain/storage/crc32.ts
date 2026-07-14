function buildCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  // Stryker disable next-line EqualityOperator: equivalent — `i <= 256` runs one extra iteration at i=256; `table[256] = c` on a `Uint32Array(256)` is a silently-ignored out-of-bounds write per the TypedArray spec, so `table[0..255]` is unaffected — identical to the un-mutated loop.
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
}

const CRC32_TABLE: Uint32Array = buildCrc32Table();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = CRC32_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
