import type { ObjectId } from '../objects/index.js';

export function computeLooseObjectPath(id: ObjectId): string {
  return `${id.slice(0, 2)}/${id.slice(2)}`;
}
