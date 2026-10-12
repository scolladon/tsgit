export interface ChunkTransform {
  readonly push: (chunk: Uint8Array) => ReadonlyArray<Uint8Array>;
  readonly flush: () => ReadonlyArray<Uint8Array>;
}
