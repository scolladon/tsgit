import { invalidIdentity } from './error.js';

export interface AuthorIdentity {
  readonly name: string;
  readonly email: string;
  readonly timestamp: number;
  readonly timezoneOffset: string;
}

export function parseIdentity(line: string): AuthorIdentity {
  const lastClose = line.lastIndexOf('>');
  if (lastClose === -1) {
    throw invalidIdentity(line, 'missing closing angle bracket');
  }

  const lastOpen = line.lastIndexOf('<', lastClose);
  if (lastOpen === -1) {
    throw invalidIdentity(line, 'missing opening angle bracket');
  }

  const rawName = line.slice(0, lastOpen);
  const name = rawName.endsWith(' ') ? rawName.slice(0, -1) : rawName;
  const email = line.slice(lastOpen + 1, lastClose);

  const afterClose = line.slice(lastClose + 1).trim();
  const parts = afterClose.split(/\s+/);
  if (parts.length < 2) {
    throw invalidIdentity(line, 'missing timestamp or timezone');
  }

  const timestamp = Number(parts[0]);
  if (!Number.isSafeInteger(timestamp)) {
    throw invalidIdentity(line, 'invalid timestamp');
  }

  const timezoneOffset = parts[1]!;
  if (!/^[+-]\d{4}$/.test(timezoneOffset)) {
    throw invalidIdentity(line, 'invalid timezone offset');
  }

  return { name, email, timestamp, timezoneOffset };
}

const CONTROL_CHARS = /[\n\r\0]/;

export function serializeIdentity(identity: AuthorIdentity): string {
  const line = `${identity.name} <${identity.email}>`;
  if (CONTROL_CHARS.test(identity.name)) {
    throw invalidIdentity(line, 'name contains forbidden control character');
  }
  if (CONTROL_CHARS.test(identity.email)) {
    throw invalidIdentity(line, 'email contains forbidden control character');
  }
  if (CONTROL_CHARS.test(identity.timezoneOffset)) {
    throw invalidIdentity(line, 'timezoneOffset contains forbidden control character');
  }
  if (identity.name.includes('<') || identity.name.includes('>')) {
    throw invalidIdentity(line, 'invalid identity fields');
  }
  if (identity.email.includes('<') || identity.email.includes('>')) {
    throw invalidIdentity(line, 'invalid identity fields');
  }
  if (!/^[+-]\d{4}$/.test(identity.timezoneOffset)) {
    throw invalidIdentity(line, 'invalid identity fields');
  }
  return `${identity.name} <${identity.email}> ${identity.timestamp} ${identity.timezoneOffset}`;
}
