import type { Ident } from '../pretty/user-format.js';
import type { MailmapRule } from './parse-mailmap.js';

interface Replacement {
  readonly name?: string | undefined;
  readonly email?: string | undefined;
}

interface EmailEntry {
  simple: Replacement;
  readonly byName: Map<string, Replacement>;
}

export type MailmapIndex = ReadonlyMap<string, EmailEntry>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const ASCII_UPPER = /[A-Z]/g;
const foldCase = (text: string): string =>
  text.replace(ASCII_UPPER, (letter) => letter.toLowerCase());

const entryFor = (index: Map<string, EmailEntry>, key: string): EmailEntry => {
  const existing = index.get(key);
  if (existing !== undefined) return existing;
  const created: EmailEntry = { simple: {}, byName: new Map() };
  index.set(key, created);
  return created;
};

const addRule = (index: Map<string, EmailEntry>, rule: MailmapRule): void => {
  const entry = entryFor(index, foldCase(rule.oldEmail));
  if (rule.oldName !== undefined) {
    entry.byName.set(foldCase(rule.oldName), { name: rule.newName, email: rule.newEmail });
    return;
  }
  entry.simple = {
    name: rule.newName ?? entry.simple.name,
    email: rule.newEmail ?? entry.simple.email,
  };
};

/** Mirrors git's `add_mapping`: simple rules merge per field, name rules replace by name. */
export const indexMailmap = (rules: readonly MailmapRule[]): MailmapIndex => {
  const index = new Map<string, EmailEntry>();
  for (const rule of rules) addRule(index, rule);
  return index;
};

const replacementFor = (entry: EmailEntry, name: string): Replacement =>
  entry.byName.get(foldCase(name)) ?? entry.simple;

/** Mirrors git's `map_user`: email matches case-insensitively, then the name refines it. */
export const mapUser = (index: MailmapIndex, ident: Ident): Ident => {
  const entry = index.get(foldCase(decoder.decode(ident.mail)));
  if (entry === undefined) return ident;
  const replacement = replacementFor(entry, decoder.decode(ident.name));
  return {
    name: replacement.name === undefined ? ident.name : encoder.encode(replacement.name),
    mail: replacement.email === undefined ? ident.mail : encoder.encode(replacement.email),
  };
};
