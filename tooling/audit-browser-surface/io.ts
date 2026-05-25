/**
 * Filesystem helpers extracted so the audit core stays import-free of
 * node-only globs (and so they are trivially mockable in unit tests).
 */
import { access, readFile, readdir } from 'node:fs/promises';
import * as path from 'node:path';

export const fileExists = async (target: string): Promise<boolean> => {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
};

export const readTextFile = async (target: string): Promise<string> => readFile(target, 'utf8');

export const scanDir = async (root: string): Promise<ReadonlyArray<string>> => {
  if (!(await fileExists(root))) return [];
  const out: string[] = [];
  const visit = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  };
  await visit(root);
  out.sort();
  return out;
};
