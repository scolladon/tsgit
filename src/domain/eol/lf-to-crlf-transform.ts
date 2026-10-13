import type { ChunkTransform } from './chunk-transform.js';

const CR = 0x0d;
const LF = 0x0a;

const expandChunk = (chunk: Uint8Array, previousWasCr: boolean): Uint8Array => {
  let insertions = 0;
  let before = previousWasCr;
  for (let at = 0; at < chunk.length; at++) {
    const byte = chunk[at] as number;
    if (byte === LF && !before) insertions++;
    before = byte === CR;
  }
  if (insertions === 0) return chunk;
  const expanded = new Uint8Array(chunk.length + insertions);
  let length = 0;
  before = previousWasCr;
  for (let at = 0; at < chunk.length; at++) {
    const byte = chunk[at] as number;
    if (byte === LF && !before) expanded[length++] = CR;
    expanded[length++] = byte;
    before = byte === CR;
  }
  return expanded;
};

export const createLfToCrlfTransform = (): ChunkTransform => {
  let previousWasCr = false;
  return {
    push: (chunk) => {
      if (chunk.length === 0) return [];
      const expanded = expandChunk(chunk, previousWasCr);
      previousWasCr = chunk[chunk.length - 1] === CR;
      return [expanded];
    },
    flush: () => [],
  };
};
