import type { GitObject, ObjectId, ObjectType } from '../objects/index.js';

export interface PeelResult {
  readonly type: ObjectType;
  readonly id: ObjectId;
}

export function peelOneLevel(object: GitObject): PeelResult | undefined {
  switch (object.type) {
    case 'tag':
      return { type: object.data.objectType, id: object.data.object };
    case 'commit':
      return { type: 'tree', id: object.data.tree };
    case 'blob':
    case 'tree':
      return undefined;
  }
}
