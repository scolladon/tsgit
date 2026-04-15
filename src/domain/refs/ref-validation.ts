import type { RefName } from '../objects/index.js';
import { invalidRef } from './error.js';

const FORBIDDEN_SIMPLE = new Set(['~', '^', ':', '?', '*', '[', '\\', ' ']);

function hasForbiddenChar(name: string): boolean {
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
    const ch = name[i];
    if (ch !== undefined && FORBIDDEN_SIMPLE.has(ch)) return true;
  }
  return false;
}

export function validateRefName(name: string): RefName {
  if (name === '') {
    throw invalidRef('ref name must not be empty');
  }
  if (name.startsWith('/') || name.endsWith('/')) {
    throw invalidRef('ref name must not start or end with /');
  }
  if (name.startsWith('-')) {
    throw invalidRef('ref name must not start with -');
  }
  if (name === '@') {
    throw invalidRef('ref name must not be single @');
  }
  if (name.includes('..')) {
    throw invalidRef('ref name must not contain ..');
  }
  if (name.includes('//')) {
    throw invalidRef('ref name must not contain consecutive slashes');
  }
  if (name.includes('@{')) {
    throw invalidRef('ref name must not contain @{');
  }
  if (name.endsWith('.')) {
    throw invalidRef('ref name must not end with .');
  }
  if (hasForbiddenChar(name)) {
    throw invalidRef('ref name contains forbidden character');
  }

  const components = name.split('/');
  for (const component of components) {
    if (component.startsWith('.')) {
      throw invalidRef('ref name component must not start with .');
    }
    if (component.endsWith('.lock')) {
      throw invalidRef('ref name component must not end with .lock');
    }
  }

  return name as RefName;
}
