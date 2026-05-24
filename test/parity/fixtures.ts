import type { AuthorIdentity } from '../../src/domain/objects/author-identity.ts';

export const AUTHOR: AuthorIdentity = {
  name: 'tsgit Parity',
  email: 'parity@tsgit.dev',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

export const MESSAGES = {
  seed: 'seed commit',
  second: 'second commit',
} as const;

export const FILES = {
  helloA: { path: 'a.txt', content: 'hello a\n' },
  helloB: { path: 'b.txt', content: 'hello b\n' },
} as const;
