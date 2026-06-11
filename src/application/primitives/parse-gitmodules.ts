/**
 * Parse `.gitmodules` text into submodule rows, in file order. Reuses the
 * `config-read` INI tokenizer (the `.gitmodules` grammar is git-config INI,
 * ADR-086) and the domain name-safety guard; unsafe-named sections are dropped.
 * Consumed by both the read-side walk (indexing rows by `path`) and the write
 * verbs (`init`/`sync`/`deinit`, iterating rows by `path`/`name`).
 */
import { isUnsafeSubmoduleName } from '../../domain/submodule/name.js';
import { type IniSection, parseIniSections } from './config-read.js';

/** A `[submodule "<name>"]` section reduced to the keys the write/read paths consume. */
export interface GitmodulesRow {
  readonly name: string;
  readonly path?: string;
  readonly url?: string;
  readonly update?: string;
  readonly branch?: string;
}

interface SubmoduleKeys {
  readonly path?: string;
  readonly url?: string;
  readonly update?: string;
  readonly branch?: string;
}

const mergeKey = (
  acc: SubmoduleKeys,
  kv: { readonly key: string; readonly value: string | null },
): SubmoduleKeys => {
  // String-typed fields skip null (valueless key treated as absent).
  if (kv.value === null) return acc;
  const k = kv.key.toLowerCase();
  if (k === 'path') return { ...acc, path: kv.value };
  if (k === 'url') return { ...acc, url: kv.value };
  if (k === 'update') return { ...acc, update: kv.value };
  if (k === 'branch') return { ...acc, branch: kv.value };
  return acc;
};

const reduceSection = (section: IniSection): GitmodulesRow | undefined => {
  if (section.section !== 'submodule') return undefined;
  if (section.subsection === undefined) return undefined;
  if (isUnsafeSubmoduleName(section.subsection)) return undefined;
  const keys = section.entries.reduce(mergeKey, {});
  return {
    name: section.subsection,
    // Stryker disable next-line ConditionalExpression,ObjectLiteral: equivalent — `{ path: undefined }` and `{}` are equal under Vitest structural equality; consumers read `row.path === undefined` either way.
    ...(keys.path !== undefined ? { path: keys.path } : {}),
    // Stryker disable next-line ConditionalExpression,ObjectLiteral: equivalent — `{ url: undefined }` matches a missing `url` field under structural equality.
    ...(keys.url !== undefined ? { url: keys.url } : {}),
    // Stryker disable next-line ConditionalExpression,ObjectLiteral: equivalent — `{ update: undefined }` matches a missing `update` field under structural equality.
    ...(keys.update !== undefined ? { update: keys.update } : {}),
    // Stryker disable next-line ConditionalExpression,ObjectLiteral: equivalent — `{ branch: undefined }` matches a missing `branch` field under structural equality.
    ...(keys.branch !== undefined ? { branch: keys.branch } : {}),
  };
};

export const parseGitmodules = (text: string): ReadonlyArray<GitmodulesRow> => {
  const rows: GitmodulesRow[] = [];
  for (const section of parseIniSections(text, '.gitmodules')) {
    const row = reduceSection(section);
    if (row === undefined) continue;
    rows.push(row);
  }
  return rows;
};
