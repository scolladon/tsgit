import type { ObjectId, RefName } from '../objects/index.js';
import { ObjectId as ObjectIdFactory } from '../objects/index.js';
import { invalidRef } from './error.js';
import type { LooseRef } from './ref-types.js';
import { validateRefName } from './ref-validation.js';

const SYMBOLIC_PREFIX = 'ref: ';

export function parseLooseRef(content: string): LooseRef {
  const trimmed = content.replace(/[\r\n]+$/, '');
  if (trimmed === '') {
    throw invalidRef('empty ref content');
  }

  if (trimmed.startsWith(SYMBOLIC_PREFIX)) {
    const target = trimmed.slice(SYMBOLIC_PREFIX.length);
    if (target === '') {
      throw invalidRef('empty symbolic ref target');
    }
    const validatedTarget = validateRefName(target);
    return { type: 'symbolic', target: validatedTarget };
  }

  return { type: 'direct', target: ObjectIdFactory.from(trimmed) };
}

export function serializeDirectRef(id: ObjectId): string {
  return `${id}\n`;
}

export function serializeSymbolicRef(target: RefName): string {
  return `ref: ${target}\n`;
}
