import type { ObjectId, RefName } from '../objects/index.js';

export interface DirectRef {
  readonly type: 'direct';
  readonly target: ObjectId;
}

export interface SymbolicRef {
  readonly type: 'symbolic';
  readonly target: RefName;
}

export type LooseRef = DirectRef | SymbolicRef;

export interface PackedRefEntry {
  readonly name: RefName;
  readonly id: ObjectId;
  readonly peeled?: ObjectId;
}

export interface PackedRefs {
  readonly entries: ReadonlyArray<PackedRefEntry>;
  readonly peeling: 'none' | 'tags' | 'fully';
  readonly sorted: boolean;
}
